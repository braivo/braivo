// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { createObjectives, type Objective, readObjectives } from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/**
 * Registers learning targets for an organization, returning their generated IDs
 * in the order the titles were given. Until `content` and `ai` derive objectives
 * from source material, a content owner names them here.
 *
 * IDs are generated rather than chosen, so two organizations can both teach the
 * past tense.
 */
export async function defineObjectives(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  titles: readonly string[];
}): Promise<string[]> {
  const { database, organizationId, actingAs, titles } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return createObjectives(database, organizationId, titles);
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
