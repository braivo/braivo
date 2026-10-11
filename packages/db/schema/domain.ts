// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "./auth.ts";

/**
 * A hostname serving one organization's learn app, and so an origin Braivo
 * trusts, for its learner sessions and its own writes, while the row exists
 * (ADR 0004, ADR 0018). Written by the operator, or once the installation's
 * provisioner proves a claim (ADR 0038): never on a member's word alone.
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

/**
 * A hostname an organization's `owner` or `admin` added, not yet proven
 * theirs (ADR 0038): it serves nothing and is trusted for nothing until,
 * the installation's provisioner reporting it ready, it is activated, moving to
 * `organization_domain`. Its status is the provisioner's, read live. A
 * hostname is one organization's across both tables, held by a lock on it
 * that every write to either takes.
 */
export const organizationDomainClaim = pgTable(
  "organization_domain_claim",
  {
    /** As `organization_domain.hostname`: lowercase, held by the check. */
    hostname: text("hostname").primaryKey(),
    /**
     * This claim, and no other: the provisioner keeps a proof, and whatever
     * serves the hostname, for a claim alone (ADR 0038), so a hostname claimed
     * again, its claim expired or its organization deleted, is proven again.
     * From a sequence, taken under the hostname's lock, so a later claim's is
     * greater, whatever the clocks say: the provisioner ignores a late addition
     * for an earlier one.
     */
    id: bigint("id", { mode: "number" }).notNull().unique().generatedAlwaysAsIdentity(),
    // Cascading, as a domain: a claim outliving its organization claims for nobody.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Seven days on, not activated, it expires: it holds nothing, and the hostname's next claim replaces it. */
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Listing an organization's claims, and the cascade from it.
    index("organization_domain_claim_organization_idx").on(table.organizationId, table.claimedAt),
    check(
      "organization_domain_claim_hostname_lowercase",
      sql`${table.hostname} = lower(${table.hostname})`,
    ),
  ],
);
