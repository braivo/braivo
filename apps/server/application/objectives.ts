// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { isKey, KEY_RULE } from "../content/index.ts";
import { createObjectives, type Objective, readObjectives } from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/** A key that is not one, named by where it was sent: "Objective 1", "The course". */
export class InvalidKey extends Error {
  constructor(what: string) {
    super(`${what} has a key that cannot be one: ${KEY_RULE}.`);
    this.name = "InvalidKey";
  }
}

/**
 * Registers learning targets for an organization, returning their IDs in the
 * order given. A content owner or their agent names them, including when
 * accepting an AI draft.
 *
 * IDs are generated rather than chosen, so two organizations can both teach the
 * past tense. A `key` is the caller's own name for one, unique within the
 * organization: adding it again returns it, so a retry adds nothing
 * (docs/adr/0024-idempotent-authoring.md).
 */
export async function defineObjectives(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  objectives: readonly { title: string; key?: string }[];
}): Promise<string[]> {
  const { database, organizationId, actingAs, objectives } = input;

  // Checked first, since it depends only on what was sent.
  for (const [index, { key }] of objectives.entries()) {
    if (key !== undefined && !isKey(key)) throw new InvalidKey(`Objective ${index}`);
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return createObjectives(database, organizationId, objectives);
}

/**
 * Every objective an organization has defined, by title: a listing order, not
 * content order, which belongs to a course.
 */
export async function listObjectives(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<Objective[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readObjectives(database, organizationId);
}
