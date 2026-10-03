// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization, user } from "./auth.ts";

/**
 * A learn domain's sign-in, under way on the installation's origin (ADR 0018):
 * started on the domain, where the browser got the nonce; completed by a member
 * signed in there, which issues the code; redeemed once, back on the domain,
 * with both. Secrets are kept as SHA-256 hashes, so a database leak redeems
 * nothing.
 */
export const learnerHandoff = pgTable(
  "learner_handoff",
  {
    /** Random, and public: it is in the sign-in page's URL. */
    id: text("id").primaryKey(),
    // Cascading, as a domain does: a handoff is a minute's state, not history.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The domain it started on and returns to, as `URL#hostname` gives it. */
    hostname: text("hostname").notNull(),
    /** Where on that domain, a path. */
    returnPath: text("return_path").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    /** Who completed it, once someone has. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // Each start deletes the expired, which should not read the live.
  (table) => [index("learner_handoff_expires_at_idx").on(table.expiresAt)],
);

/**
 * Braivo's own session on a learn domain, never Better Auth's: one user, one
 * organization, accepted only on the domain it was handed to, while that
 * still serves the organization; only learner routes take it as identity
 * (ADR 0018). It grants no membership, which is checked on every request.
 */
export const learnerSession = pgTable(
  "learner_session",
  {
    /** SHA-256 of the cookie's token. */
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The domain it was handed to. The organization's later domains refuse
     * it, so a token kept by a domain's former operator opens nothing there.
     */
    hostname: text("hostname").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // Expiry for the deletes on each redemption; the others for the cascades
  // from a deleted user or organization, which PostgreSQL does not index.
  (table) => [
    index("learner_session_expires_at_idx").on(table.expiresAt),
    index("learner_session_user_id_idx").on(table.userId),
    index("learner_session_organization_id_idx").on(table.organizationId),
  ],
);
