// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Auth } from "./auth.ts";
import { MIN_REVIEWER_PASSWORD_LENGTH } from "./auth.ts";

/** Better Auth's provider ID for a password, which `/sign-in/email` reads. */
const CREDENTIAL = "credential";

/**
 * A password for a reviewer, random and shown once: 24 bytes, 32 characters
 * of base64url, long past `MIN_REVIEWER_PASSWORD_LENGTH`.
 */
export function generateReviewerPassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/**
 * Sets the password of an existing account, the operator's command and the
 * only way one is set (ADR 0018), replacing any it had. It signs in only
 * while `BRAIVO_REVIEWER_EMAILS` lists the account's email.
 */
export async function setReviewerPassword(
  auth: Auth,
  input: { email: string; password: string },
): Promise<void> {
  const { internalAdapter, password } = await auth.$context;
  if (input.password.length < MIN_REVIEWER_PASSWORD_LENGTH) {
    throw new Error(
      `A reviewer's password has at least ${MIN_REVIEWER_PASSWORD_LENGTH} characters; leave it out for a random one.`,
    );
  }
  // Better Auth's maximum, past which `/sign-in/email` refuses it.
  if (input.password.length > 128)
    throw new Error("A reviewer's password has at most 128 characters.");
  const found = await internalAdapter.findUserByEmail(input.email.toLowerCase());
  if (!found) throw new Error(`No account uses ${input.email}: sign in with it once first.`);
  const hash = await password.hash(input.password);
  const credential = await internalAdapter.findCredentialAccount(found.user.id);
  if (credential) await internalAdapter.updatePassword(found.user.id, hash);
  else {
    await internalAdapter.createAccount({
      userId: found.user.id,
      providerId: CREDENTIAL,
      accountId: found.user.id,
      password: hash,
    });
  }
}

/**
 * Removes an account's password and ends its sessions, at once (the session
 * cookie cache is off), even if it had no password, answered `false`. Its
 * email still signs in by code. Its AI apps' connections outlive this:
 * disconnect them in the console.
 */
export async function removeReviewerPassword(auth: Auth, email: string): Promise<boolean> {
  const { adapter, internalAdapter } = await auth.$context;
  const found = await internalAdapter.findUserByEmail(email.toLowerCase());
  if (!found) return false;
  const where = [
    { field: "userId", value: found.user.id },
    { field: "providerId", value: CREDENTIAL },
  ];
  const had = (await adapter.findOne({ model: "account", where })) !== null;
  if (had) await adapter.deleteMany({ model: "account", where });
  // Whether or not a password is left: one gone some other way may have
  // opened sessions still standing.
  await internalAdapter.deleteUserSessions(found.user.id);
  return had;
}
