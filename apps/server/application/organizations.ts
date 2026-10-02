// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type Member,
  type Organization,
  readMembers,
  readMemberships,
} from "../persistence/index.ts";
import { administers, assertMayAdminister } from "./permission.ts";

/**
 * The organizations someone manages (`owner` or `admin`), by name: the
 * console's list. Not every membership, since a learner is a member too.
 */
export async function listManagedOrganizations(input: {
  database: Database;
  actingAs: string;
}): Promise<Organization[]> {
  const memberships = await readMemberships(input.database, input.actingAs);
  return memberships.filter(({ roles }) => administers(roles)).map((m) => m.organization);
}

/**
 * Every member of an organization, for whoever administers it. A learner may
 * not list the others: membership is not a directory of classmates.
 */
export async function listMembers(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<Member[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readMembers(database, organizationId);
}
