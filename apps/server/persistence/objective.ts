// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { objective } from "@braivo/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

export type Objective = { id: string; title: string };

/**
 * Registers learning targets for a content owner and returns their generated
 * IDs, positionally matching the titles given.
 *
 * The IDs are generated here rather than by the database so that the returned
 * order is the caller's own, instead of depending on the order a multi-row
 * `RETURNING` happens to produce.
 */
export async function createObjectives(
  database: Database,
  organizationId: string,
  titles: readonly string[],
): Promise<string[]> {
  if (titles.length === 0) return [];

  const rows = titles.map((title) => ({ id: crypto.randomUUID(), organizationId, title }));
  await database.insert(objective).values(rows);

  return rows.map((row) => row.id);
}

/**
 * Which of these objectives the organization does not own — including any that
 * do not exist, since from here the two are the same answer: not yours.
 *
 * Returned rather than counted so that a rejection can name them. This query,
 * not a foreign key, is what ties evidence to one organization: an objective's
 * owner never changes, but membership does, and evidence is history that must
 * outlive a learner leaving. A reference to `member` would either refuse that
 * departure or erase the history with it.
 */
export async function findObjectivesOutsideOrganization(
  database: Database,
  organizationId: string,
  objectiveIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(objectiveIds)];
  if (wanted.length === 0) return [];

  const owned = await database
    .select({ id: objective.id })
    .from(objective)
    .where(and(eq(objective.organizationId, organizationId), inArray(objective.id, wanted)));

  const inside = new Set(owned.map((row) => row.id));
  return wanted.filter((id) => !inside.has(id));
}

/**
 * Every objective a content owner has defined, by title.
 *
 * This is a listing order, not content order. The sequence a learner meets
 * objectives in comes from a course, and reaches `learning` as an already-ordered
 * candidate list — conflating the two
 * is how an alphabetical accident would become a curriculum.
 */
export async function readObjectives(
  database: Database,
  organizationId: string,
): Promise<Objective[]> {
  return database
    .select({ id: objective.id, title: objective.title })
    .from(objective)
    .where(eq(objective.organizationId, organizationId))
    .orderBy(asc(objective.title), asc(objective.id));
}
