// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { organization, organizationDomain } from "@braivo/db/schema";
import { eq } from "drizzle-orm";

import type { Organization } from "./membership.ts";

/** The organization a hostname serves, or `undefined` when it serves none. */
export async function readDomainOrganization(
  database: Database,
  hostname: string,
): Promise<Organization | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organizationDomain)
    .innerJoin(organization, eq(organization.id, organizationDomain.organizationId))
    .where(eq(organizationDomain.hostname, hostname));

  return row;
}

/** The hostname serving an organization's learn app, or `undefined` while none does. */
export async function readLearnDomain(
  database: Database,
  organizationId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ hostname: organizationDomain.hostname })
    .from(organizationDomain)
    .where(eq(organizationDomain.organizationId, organizationId));

  return row?.hostname;
}

/**
 * Maps a hostname to an organization, answering whether this call inserted it:
 * `false` when either already has a mapping, this one included. The constraints
 * decide, so concurrent calls cannot both win; the caller reads which did.
 */
export async function insertLearnDomain(
  database: Database,
  input: { hostname: string; organizationId: string },
): Promise<boolean> {
  const inserted = await database
    .insert(organizationDomain)
    .values(input)
    .onConflictDoNothing()
    .returning({ hostname: organizationDomain.hostname });

  return inserted.length > 0;
}
