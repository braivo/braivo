// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { objectiveCitation, source } from "@braivo/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

/** A verified passage citation, positions in code points. */
export type Citation = { objectiveId: string; sourceId: string; start: number; end: number };

/** A citation read back with the passage it points at. */
export type CitedPassage = { sourceId: string; start: number; end: number; quote: string };

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
 * is already stored is left as it is, so a retried write changes nothing.
 */
export async function createCitations(
  database: Database,
  organizationId: string,
  citations: readonly Citation[],
): Promise<void> {
  if (citations.length === 0) return;

  await database
    .insert(objectiveCitation)
    .values(citations.map((citation) => ({ organizationId, ...citation })))
    .onConflictDoNothing();
}

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
    })
    .from(objectiveCitation)
    .innerJoin(source, eq(source.id, objectiveCitation.sourceId))
    .where(eq(objectiveCitation.objectiveId, objectiveId))
    .orderBy(asc(objectiveCitation.sourceId), asc(objectiveCitation.start));
}
