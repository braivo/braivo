// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Database } from "@braivo/db";

import { spendSignInNonce, storeSignInNonce } from "../persistence/index.ts";
import { later, randomToken } from "./learner-sessions.ts";

// The nonce a native app's ID token carries (ADR 0062). Braivo issues it and
// spends it once, so no token, leaked or stored, signs in twice: the app gives
// the provider the nonce's hash, which the token then carries, and sends the
// raw nonce with the token. Stored as that same hash, so the database holds
// only what tokens carry, never what redeems one.

/** Long enough for a provider's sheet, short enough that a stray one lapses soon. */
const SIGN_IN_NONCE_SECONDS = 600;

/**
 * What the app hands Apple or Google as the nonce, and what Braivo stores:
 * the lowercase hex SHA-256 of the raw nonce's UTF-8 bytes. Hex, not
 * base64url, as Apple's documentation hashes it and Better Auth compares it.
 */
function signInNonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/** A new nonce, good once for `SIGN_IN_NONCE_SECONDS`. */
export async function issueSignInNonce(input: {
  database: Database;
  now: Date;
}): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = randomToken();
  const expiresAt = later(input.now, SIGN_IN_NONCE_SECONDS);
  await storeSignInNonce(input.database, {
    hash: signInNonceHash(nonce),
    at: input.now,
    expiresAt,
  });
  return { nonce, expiresAt };
}

/**
 * Spends `nonce`, answering its hash for the token's claim to be compared
 * with, or `undefined` if it is unknown, expired, or spent.
 */
export async function redeemSignInNonce(input: {
  database: Database;
  nonce: string;
  now: Date;
}): Promise<string | undefined> {
  const hash = signInNonceHash(input.nonce);
  return (await spendSignInNonce(input.database, { hash, at: input.now })) ? hash : undefined;
}
