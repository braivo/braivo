// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { type Organization, readMemberships } from "../persistence/index.ts";
import { administers } from "./permission.ts";

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
