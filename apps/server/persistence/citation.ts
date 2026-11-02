// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import { objectiveCitation, source } from "@braivo/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { momentOf, pageOf, type Pagination, type Timing } from "../content/index.ts";

/** A verified passage citation, positions in code points. */
export type Citation = { objectiveId: string; sourceId: string; start: number; end: number };

/**
 * A citation read back with the passage it points at, and whether a person
 * published it, so learners' reviews show it (ADR 0054).
 */
export type CitedPassage = {
  sourceId: string;
  start: number;
  end: number;
  quote: string;
  published: boolean;
};

/**
 * The text of each of these sources the organization owns, by ID. One it does
 * not own is simply absent, since from here that is the same answer as one that
 * does not exist.
 */
export async function readSourceTexts(
  database: Database,
  organizationId: string,
  sourceIds: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(sourceIds)];
  if (wanted.length === 0) return new Map();

  const rows = await database
    .select({ id: source.id, text: source.text })
    .from(source)
    .where(and(eq(source.organizationId, organizationId), inArray(source.id, wanted)));

  return new Map(rows.map((row) => [row.id, row.text]));
}

/**
 * Stores citations already located by `content`, all or none. A citation that
 * is already stored is left as it is, so a retried write changes nothing,
 * except that one written published publishes one still pending.
 */
export async function createCitations(
  database: Database,
  organizationId: string,
  citations: readonly Citation[],
  /** When a person published them, as written; absent, they wait (ADR 0039). */
  publishedAt?: Date,
): Promise<void> {
  if (citations.length === 0) return;

  // In primary-key order, whatever order they were sent in, as evidence is: two
  // writers inserting overlapping citations in different orders could each hold
  // a row the other waits for, and deadlock. Each once: an upsert may not touch
  // a row twice.
  const unique = [
    ...new Map(citations.map((citation) => [citationKey(citation), citation])).values(),
  ];
  await database
    .insert(objectiveCitation)
    .values(
      unique
        .toSorted(keyOrder)
        .map((citation) => ({ organizationId, ...citation, publishedAt: publishedAt ?? null })),
    )
    .onConflictDoUpdate({
      target: [
        objectiveCitation.objectiveId,
        objectiveCitation.sourceId,
        objectiveCitation.start,
        objectiveCitation.end,
      ],
      // Published once, it keeps when.
      set: { publishedAt: sql`coalesce(${objectiveCitation.publishedAt}, excluded.published_at)` },
    });
}

/**
 * Publishes these citations of the organization, in one transaction with the
 * courses and tasks published beside them: `false`, publishing nothing, when
 * one is not the organization's. One published already keeps when it was.
 */
export async function publishCitations(
  transaction: Transaction,
  input: { organizationId: string; citations: readonly Citation[]; now: Date },
): Promise<boolean> {
  const { organizationId, citations, now } = input;
  if (citations.length === 0) return true;

  const keys = sql.join(
    citations.map(
      ({ objectiveId, sourceId, start, end }) =>
        sql`(${objectiveId}, ${sourceId}, ${start}::integer, ${end}::integer)`,
    ),
    sql`, `,
  );
  const matching = and(
    eq(objectiveCitation.organizationId, organizationId),
    sql`(${objectiveCitation.objectiveId}, ${objectiveCitation.sourceId}, ${objectiveCitation.start}, ${objectiveCitation.end}) in (${keys})`,
  );
  // Locked in key order, as `createCitations` writes them, so two publishers never deadlock.
  const found = await transaction
    .select({ objectiveId: objectiveCitation.objectiveId })
    .from(objectiveCitation)
    .where(matching)
    .orderBy(
      asc(objectiveCitation.objectiveId),
      asc(objectiveCitation.sourceId),
      asc(objectiveCitation.start),
      asc(objectiveCitation.end),
    )
    .for("update");
  if (found.length !== new Set(citations.map(citationKey)).size) return false;
  await transaction
    .update(objectiveCitation)
    .set({ publishedAt: now })
    .where(and(matching, isNull(objectiveCitation.publishedAt)));
  return true;
}

function citationKey({ objectiveId, sourceId, start, end }: Citation): string {
  return JSON.stringify([objectiveId, sourceId, start, end]);
}

function keyOrder(a: Citation, b: Citation): number {
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    text(a.objectiveId, b.objectiveId) ||
    text(a.sourceId, b.sourceId) ||
    a.start - b.start ||
    a.end - b.end
  );
}

/** A citation a person published (docs/adr/0054-review-shows-an-objectives-own-passages.md). */
const publishedCitation = isNotNull(objectiveCitation.publishedAt);

/**
 * The passages an objective cites, in source and text order. The quote is cut
 * out by PostgreSQL, whose `substr` counts code points as the positions do, so
 * a long source's text never leaves the database for it.
 */
export async function readObjectiveCitations(
  database: Database,
  objectiveId: string,
): Promise<CitedPassage[]> {
  return database
    .select({
      sourceId: objectiveCitation.sourceId,
      start: objectiveCitation.start,
      end: objectiveCitation.end,
      quote: sql<string>`substr(${source.text}, ${objectiveCitation.start} + 1, ${objectiveCitation.end} - ${objectiveCitation.start})`,
      published: sql<boolean>`${publishedCitation}`,
    })
    .from(objectiveCitation)
    .innerJoin(source, eq(source.id, objectiveCitation.sourceId))
    .where(eq(objectiveCitation.objectiveId, objectiveId))
    .orderBy(asc(objectiveCitation.sourceId), asc(objectiveCitation.start));
}

/**
 * A passage as a learner reads it: the words, where they begin in a recording
 * or a book when the source keeps that, and the source's title and link. Never
 * the source's text or positions (sources-17).
 */
export type LearnerPassage = {
  quote: string;
  /** The second of the recording it is said at, when the source is a timed transcript. */
  at?: number;
  /** The label of the page it is on, when the source is a paged document. */
  page?: string;
  source: { title: string; url?: string };
};

/**
 * A cited passage's row as `LearnerPassage`: where it begins in the original,
 * when the source keeps that.
 */
export function toLearnerPassage(row: {
  start: number;
  quote: string;
  title: string;
  url: string | null;
  timing: unknown;
  pagination: unknown;
}): LearnerPassage {
  const { start, quote, title, url, timing, pagination } = row;
  const at = timing === null ? undefined : momentOf(timing as Timing, start);
  const page = pagination === null ? undefined : pageOf(pagination as Pagination, start);
  return {
    quote,
    ...(at === undefined ? {} : { at }),
    ...(page === undefined ? {} : { page }),
    source: url === null ? { title } : { title, url },
  };
}

/**
 * The passages a learner reviewing the objective reads: its published
 * citations, in a grade's order (source title, then position), the first
 * `limit` of them.
 */
export async function readReviewPassages(
  database: Database,
  input: { objectiveId: string; limit: number },
): Promise<LearnerPassage[]> {
  const rows = await database
    .select({
      start: objectiveCitation.start,
      quote: sql<string>`substr(${source.text}, ${objectiveCitation.start} + 1, ${objectiveCitation.end} - ${objectiveCitation.start})`,
      title: source.title,
      url: source.url,
      timing: source.timing,
      pagination: source.pagination,
    })
    .from(objectiveCitation)
    .innerJoin(source, eq(source.id, objectiveCitation.sourceId))
    .where(and(eq(objectiveCitation.objectiveId, input.objectiveId), publishedCitation))
    .orderBy(
      asc(source.title),
      asc(objectiveCitation.sourceId),
      asc(objectiveCitation.start),
      asc(objectiveCitation.end),
    )
    .limit(input.limit);
  return rows.map(toLearnerPassage);
}

/** Whether reviewing the objective would show a passage (`readReviewPassages`). */
export async function hasReviewPassage(database: Database, objectiveId: string): Promise<boolean> {
  const [row] = await database
    .select({ found: sql<number>`1` })
    .from(objectiveCitation)
    .where(and(eq(objectiveCitation.objectiveId, objectiveId), publishedCitation))
    .limit(1);
  return row !== undefined;
}
