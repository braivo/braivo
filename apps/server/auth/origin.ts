// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { readDomainOrganization } from "../persistence/index.ts";

/**
 * Whether `origin` is an organization's own domain, and so a page Braivo serves
 * (ADR 0004). Looked up on every call rather than listed once, so a domain
 * stops being trusted the moment it stops resolving to an organization.
 *
 * HTTPS on the default port only: that is the one origin a custom domain is
 * served from, and anything else under the same name is not Braivo's page.
 */
export async function isOrganizationOrigin(database: Database, origin: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (origin !== `https://${url.hostname}`) return false;

  return (await readDomainOrganization(database, url.hostname)) !== undefined;
}
