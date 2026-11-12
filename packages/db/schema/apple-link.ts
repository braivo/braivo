// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * An Apple identity waiting to be linked by a code to the account holding its
 * email (ADR 0063): ten minutes, spent once, keyed by its ID's hash, holding
 * the verified identity and the authorization its code was exchanged for.
 * Not Better Auth's `verification` table, which deletes expired rows on its
 * own lookups: a lapsed link's token must be revoked, not dropped.
 */
export const appleLink = pgTable(
  "apple_link",
  {
    /** SHA-256 of the link ID the app holds. */
    idHash: text("id_hash").primaryKey(),
    /** The address its code goes to, lowercased. */
    email: text("email").notNull(),
    /** Apple's subject for the identity. */
    subject: text("subject").notNull(),
    /** Encrypted under the installation's secret, as an account keeps it. */
    refreshToken: text("refresh_token"),
    /** The bundle ID the token was issued to. */
    refreshTokenClientId: text("refresh_token_client_id"),
    /** The name Apple sent once, or empty. */
    name: text("name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("apple_link_expires_at_idx").on(table.expiresAt),
    index("apple_link_email_idx").on(table.email),
    index("apple_link_subject_idx").on(table.subject),
  ],
);
