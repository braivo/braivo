// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { organization, organizationDomain } from "@braivo/db/schema";
import { eq } from "drizzle-orm";

/** The organization a hostname serves, or `undefined` when it serves none. */
export async function readDomainOrganization(
  database: Database,
  hostname: string,
): Promise<{ id: string; name: string } | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name })
    .from(organizationDomain)
    .innerJoin(organization, eq(organization.id, organizationDomain.organizationId))
    .where(eq(organizationDomain.hostname, hostname));

  return row;
}
