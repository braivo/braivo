// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { verification } from "@braivo/db/schema/auth";
import { and, eq, gt, like, lte } from "drizzle-orm";

// A nonce for a native app's ID token (ADR 0062), a row of Better Auth's
// `verification` table keyed by its hash, as a code's minute is
// (`sign-in-code.ts`): it names no account or address.
const PREFIX = "sign-in-nonce:";

/**
 * Stores a nonce by its hash until `expiresAt`, deleting those expired by
 * `at`: Better Auth deletes an expired row only when it looks it up, and it
 * never looks up a nonce, so one never spent would otherwise stay.
 */
export async function storeSignInNonce(
  database: Database,
  input: { hash: string; at: Date; expiresAt: Date },
): Promise<void> {
  const { hash, at, expiresAt } = input;
  await database
    .delete(verification)
    .where(and(like(verification.id, `${PREFIX}%`), lte(verification.expiresAt, at)));
  const id = `${PREFIX}${hash}`;
  await database
    .insert(verification)
    .values({ id, identifier: id, value: "", expiresAt, createdAt: at, updatedAt: at });
}

/**
 * Spends the nonce with `hash` if it is live at `at`: one statement, so of
 * two requests carrying it at once only one succeeds.
 */
export async function spendSignInNonce(
  database: Database,
  input: { hash: string; at: Date },
): Promise<boolean> {
  const spent = await database
    .delete(verification)
    .where(and(eq(verification.id, `${PREFIX}${input.hash}`), gt(verification.expiresAt, input.at)))
    .returning({ id: verification.id });
  return spent.length > 0;
}
