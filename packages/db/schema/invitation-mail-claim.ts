// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "./auth.ts";

/**
 * A claim on the invitation mail bounds (ADR 0018), one per mail sent or
 * tried: per address a day across organizations, a minute between two, and
 * per organization an hour. A row is claimed before Better Auth is asked and
 * removed if it refuses, so refusals count nothing. Rows older than a day
 * count nothing either, and are deleted as new ones are written.
 */
export const invitationMailClaim = pgTable(
  "invitation_mail_claim",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Trimmed and lowercased, as an invitation stores it. */
    email: text("email").notNull(),
    // Kept when the organization goes: deleting one must not reset an
    // address's bound.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("invitation_mail_claim_email_claimed_at_idx").on(table.email, table.claimedAt),
    index("invitation_mail_claim_organization_id_claimed_at_idx").on(
      table.organizationId,
      table.claimedAt,
    ),
    index("invitation_mail_claim_claimed_at_idx").on(table.claimedAt),
  ],
);
