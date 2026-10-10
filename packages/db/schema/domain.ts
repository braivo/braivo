// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "./auth.ts";

/**
 * A hostname serving one organization's learn app, and so an origin Braivo
 * trusts, for its learner sessions and its own writes, while the row exists
 * (ADR 0004, ADR 0018). Written by the operator, never by an organization's
 * members.
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
    /**
     * An organization may have several, each serving its learn app: the latest
     * registered is the one named wherever its learn domain is, the others
     * still serving, as `<slug>.braivo.app` does once a custom domain is
     * added, for when that one does not work (ADR 0004).
     */
    registeredAt: timestamp("registered_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Finding an organization's domains, and the cascade from it.
    index("organization_domain_organization_idx").on(table.organizationId, table.registeredAt),
    check(
      "organization_domain_hostname_lowercase",
      sql`${table.hostname} = lower(${table.hostname})`,
    ),
  ],
);
