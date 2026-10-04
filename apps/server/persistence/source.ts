// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { source } from "@braivo/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { type Pagination, sourceDigest, type Timing } from "../content/index.ts";

/**
 * A source as it is listed: everything but its text, which may be long, and
 * how it maps back to a recording or pages. `url`, `language`, and
 * `original` are absent rather than null when the source has none.
 */
export type SourceSummary = {
  id: string;
  title: string;
  url?: string;
  language?: string;
  /** The SHA-256 of the file it was extracted from. */
  original?: string;
  createdAt: Date;
};

/**
 * A source, text included, with a transcript's timing or a document's
 * pagination — each absent when the source has none.
 */
export type Source = SourceSummary & { text: string; timing?: Timing; pagination?: Pagination };

/**
 * Stores a source and returns its ID — or, when the organization already has
 * the same one, returns that one's and stores nothing (docs/adr/0024-idempotent-authoring.md).
 * Every value must already be in the form `content` gives it, since a stored
 * source is never edited and sameness is judged on exactly those values.
 *
 * Race-safe: two writers adding the same source both get the one row, because
 * the unique digest decides and the loser reads the winner's.
 */
export async function createSource(
  database: Database,
  input: {
    organizationId: string;
    title: string;
    text: string;
    url?: string;
    language?: string;
    /** The SHA-256 of one of the organization's files, recorded before. */
    original?: string;
    createdAt: Date;
  } &
    /** As `content.joinCues` or `content.joinPages` built it with the text; never both. */
    ({ timing?: Timing; pagination?: undefined } | { pagination?: Pagination; timing?: undefined }),
): Promise<string> {
  const digest = sourceDigest(input);
  const [inserted] = await database
    .insert(source)
    .values({ id: crypto.randomUUID(), ...input, digest })
    .onConflictDoNothing({ target: [source.organizationId, source.digest] })
    .returning({ id: source.id });
  if (inserted) return inserted.id;

  const [existing] = await database
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.organizationId, input.organizationId), eq(source.digest, digest)))
    .limit(1);
  if (!existing) throw new Error("A source conflicted on its digest and then was not there.");
  return existing.id;
}

const summaryColumns = {
  id: source.id,
  title: source.title,
  url: source.url,
  language: source.language,
  original: source.original,
  createdAt: source.createdAt,
};

/** A row with its nulls dropped, so an answer carries only what a source has. */
function present<
  T extends { url: string | null; language: string | null; original: string | null },
>({ url, language, original, ...rest }: T) {
  return {
    ...rest,
    ...(url === null ? {} : { url }),
    ...(language === null ? {} : { language }),
    ...(original === null ? {} : { original }),
  };
}

/** Every source an organization has, by title, without their text. */
export async function readSources(
  database: Database,
  organizationId: string,
): Promise<SourceSummary[]> {
  const rows = await database
    .select(summaryColumns)
    .from(source)
    .where(eq(source.organizationId, organizationId))
    .orderBy(asc(source.title), asc(source.id));

  return rows.map(present);
}

/**
 * One source, or `undefined` when this organization has none by that ID —
 * including when another organization does, since from here that is the same
 * answer.
 *
 * Safe to read from a cache: a source never changes, and its ID is generated
 * here, so nobody asks for it before it exists.
 */
export async function readSource(
  database: Database,
  organizationId: string,
  sourceId: string,
): Promise<Source | undefined> {
  const [row] = await database
    .select({
      ...summaryColumns,
      text: source.text,
      timing: source.timing,
      pagination: source.pagination,
    })
    .from(source)
    .where(and(eq(source.organizationId, organizationId), eq(source.id, sourceId)))
    .limit(1);
  if (!row) return undefined;

  const { timing, pagination, ...rest } = present(row);
  return {
    ...rest,
    ...(timing === null ? {} : { timing: timing as Timing }),
    ...(pagination === null ? {} : { pagination: pagination as Pagination }),
  };
}
