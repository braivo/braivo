// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { objective } from "@braivo/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

import { ConflictingKey } from "./key.ts";

export type Objective = { id: string; title: string };

/**
 * Registers learning targets for a content owner and returns their IDs,
 * positionally matching the objectives given — a title, or a title with the
 * caller's key.
 *
 * A keyed objective the organization already has under that key is not added
 * again: its ID is returned, if its title is the one sent, and otherwise the
 * whole batch is refused as a `ConflictingKey`. So a retry adds nothing, and a
 * key cannot quietly come to mean two things (docs/adr/0024-idempotent-authoring.md).
 * A key repeated within the batch is one objective, on the same terms.
 *
 * The IDs are generated here rather than by the database so that the returned
 * order is the caller's own, instead of depending on the order a multi-row
 * `RETURNING` happens to produce.
 */
export async function createObjectives(
  database: Database,
  organizationId: string,
  objectives: readonly (string | { title: string; key?: string })[],
): Promise<string[]> {
  if (objectives.length === 0) return [];

  const items = objectives.map((item) => (typeof item === "string" ? { title: item } : item));
  const rows = items.map(({ title, key }) => ({
    id: crypto.randomUUID(),
    organizationId,
    title,
    key: key ?? null,
  }));

  return database.transaction(async (transaction) => {
    // Unique on (organization, key), and keyless rows never conflict: nulls are
    // distinct. A writer racing on the same key waits for the other to commit —
    // so keys are inserted in one order, whatever order they were sent in: two
    // batches naming the same keys differently would otherwise each hold one the
    // other waits for, and deadlock. The IDs keep the caller's order.
    const inserted = await transaction
      .insert(objective)
      .values(rows.toSorted((a, b) => keyOrder(a.key, b.key)))
      .onConflictDoNothing({ target: [objective.organizationId, objective.key] })
      .returning({ id: objective.id });
    const added = new Set(inserted.map((row) => row.id));

    const keys = [...new Set(rows.filter((row) => !added.has(row.id)).map((row) => row.key!))];
    const named = keys.length
      ? await transaction
          .select({ id: objective.id, title: objective.title, key: objective.key })
          .from(objective)
          .where(and(eq(objective.organizationId, organizationId), inArray(objective.key, keys)))
      : [];
    const byKey = new Map(named.map((row) => [row.key, row]));

    return rows.map((row, index) => {
      if (added.has(row.id)) return row.id;
      const existing = byKey.get(row.key)!;
      if (existing.title !== row.title) {
        throw new ConflictingKey(`Objective ${index}`, row.key!, "an objective with another title");
      }
      return existing.id;
    });
  });
}

/** Keys in code-unit order, keyless last: the same order on every server, whatever its locale. */
function keyOrder(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
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

/** One objective, by its ID alone: the caller has already established it may be read. */
export async function readObjective(
  database: Database,
  objectiveId: string,
): Promise<Objective | undefined> {
  const [row] = await database
    .select({ id: objective.id, title: objective.title })
    .from(objective)
    .where(eq(objective.id, objectiveId));
  return row;
}

/** Titles by objective ID, for objectives already known to be readable. */
export async function readObjectiveTitles(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Map<string, string>> {
  if (objectiveIds.length === 0) return new Map();

  const rows = await database
    .select({ id: objective.id, title: objective.title })
    .from(objective)
    .where(inArray(objective.id, [...objectiveIds]));
  return new Map(rows.map((row) => [row.id, row.title]));
}
