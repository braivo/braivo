// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { organization } from "./auth.ts";

/**
 * A hostname serving one organization's learn app, and so an origin Braivo
 * trusts while the row exists (ADR 0004). Written only for a hostname the
 * operator controls, never by an organization's members: until learn domains
 * get scoped sessions (ADR 0018), whoever controls it could take sessions that
 * act in every organization.
 */
export const organizationDomain = pgTable(
  "organization_domain",
  {
    /**
     * As `URL#hostname` gives it, so a lookup matches: lowercase, no port. The
     * check makes a mixed-case write fail rather than never match.
     */
    hostname: text("hostname").primaryKey(),
    // Cascading: a domain is an address, not history, and outliving its
    // organization would leave it trusted on behalf of nobody.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
  },
  (table) => [
    // One learn domain per organization, found from the organization when
    // needed (ADR 0018). Several would need a notion of primary; not yet.
    uniqueIndex("organization_domain_organization_idx").on(table.organizationId),
    check(
      "organization_domain_hostname_lowercase",
      sql`${table.hostname} = lower(${table.hostname})`,
    ),
  ],
);
