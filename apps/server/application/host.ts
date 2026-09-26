// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { readDomainOrganization } from "../persistence/index.ts";

/**
 * The organization a hostname serves, as its learn app presents it, or
 * `undefined` when the hostname serves none (ADR 0004). Public: anyone can
 * visit the domain, and what it shows is the name it is branded with.
 */
export async function readHostOrganization(input: {
  database: Database;
  hostname: string;
}): Promise<{ name: string } | undefined> {
  const found = await readDomainOrganization(input.database, input.hostname);
  return found && { name: found.name };
}

/**
 * The host a request came to: the installation's own, where every organization
 * is reachable, or another, which reaches the organization it serves if any.
 */
export type RequestHost = { hostname: string; installation: boolean };

/**
 * Whether a request to `host` may reach `organizationId`'s data (ADR 0004): on
 * the installation's host, any; on an organization's domain, only its own; on
 * any other host, none, so deleting a domain's row revokes rather than widens.
 * A ceiling, never a grant: the caller is still authorized separately.
 */
export async function hostAdmits(
  database: Database,
  host: RequestHost,
  organizationId: string,
): Promise<boolean> {
  if (host.installation) return true;
  const served = await readDomainOrganization(database, host.hostname);
  return served?.id === organizationId;
}
