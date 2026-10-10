// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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

/**
 * A learn domain's own sign-in code for an address (ADR 0018): good on that
 * hostname alone, for the organization it served when sent, as a learner
 * session for a member. One row per hostname and address, holding the code
 * until it is spent and the minute between codes past it. The code is kept
 * as an HMAC under the installation's secret: six digits are too few for a
 * plain hash, which a database leak would reverse.
 */
export const learnerSignInCode = pgTable(
  "learner_sign_in_code",
  {
    hostname: text("hostname").notNull(),
    /** Lowercased, as Better Auth's codes are. */
    email: text("email").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `null` once spent. */
    codeHash: text("code_hash"),
    /** Wrong guesses at this code. */
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Until when another code to the address here is refused. */
    resendAt: timestamp("resend_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // Expiry for the deletes on each send; the organization for its cascade.
  (table) => [
    primaryKey({ columns: [table.hostname, table.email] }),
    index("learner_sign_in_code_expires_at_idx").on(table.expiresAt),
    index("learner_sign_in_code_organization_id_idx").on(table.organizationId),
  ],
);
