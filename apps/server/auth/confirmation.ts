// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenericEndpointContext } from "@better-auth/core";
import { defineRequestState } from "@better-auth/core/context";
import type { Database } from "@braivo/db";
import { APIError, type createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { revokeUnprovenAccountAccess } from "better-auth/db";

import { endAccountAccess } from "../persistence/index.ts";

// Confirming an email that Sign in with Apple left unconfirmed (ADR 0063): by
// a code, or by a token from a provider that controls the mailbox. Within a
// session of the account, nothing else changes. Anywhere else, whoever proved
// the mailbox is not taken to be the Apple Account's holder: the Apple
// identity is unlinked, its token revoked (the account delete hook), and every
// other way into the account ended.
//
// Every session of an unconfirmed account is its Apple identity's: a code
// sign-in confirms the account, ending them all, and nothing else signs one
// in. So "a session of the account" is "the Apple session".

/** What a Better Auth hook is given. */
type AuthContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The unconfirmed account a code sign-in in progress is confirming, if any. */
const confirmingByCode = defineRequestState((): string | undefined => undefined);

/**
 * Confirms `userId`'s email outside its Apple session: Better Auth's own
 * strip (every linked identity, each `account` delete revoking an Apple token,
 * then its sessions, then verified, under its lock), then the rest of the
 * account's ways in, Braivo's and the connections'. Links go before sessions,
 * which an Apple sign-in in flight relies on (`native-sign-in.ts`).
 */
export async function confirmElsewhere(
  context: GenericEndpointContext,
  database: Database,
  userId: string,
): Promise<void> {
  await revokeUnprovenAccountAccess(context, userId);
  await endAccountAccess(database, { userId });
}

const addressOf = (body: unknown) => {
  const { email } = (body ?? {}) as { email?: unknown };
  return typeof email === "string" ? email.trim().toLowerCase() : "";
};

/**
 * Admits asking for, and redeeming, a code that confirms an email in place
 * (`email-verification`) only within a session of the account whose
 * unconfirmed email it is.
 */
export async function assertConfirmingInSession(context: AuthContext): Promise<void> {
  const session = await getSessionFromCtx(context);
  const user = session?.user;
  if (user && !user.emailVerified && user.email === addressOf(context.body)) return;
  throw new APIError("FORBIDDEN", {
    code: "EMAIL_CONFIRMATION_NOT_ALLOWED",
    message: "Confirm an email only while signed in to its account, and only while unconfirmed.",
  });
}

/**
 * Before a code sign-in: notes the unconfirmed account it would confirm,
 * which Better Auth strips as `confirmElsewhere` does once the code holds.
 */
export async function beforeCodeSignIn(context: AuthContext): Promise<void> {
  const email = addressOf(context.body);
  if (email === "") return;
  const found = await context.context.internalAdapter.findUserByEmail(email);
  if (found && !found.user.emailVerified) await confirmingByCode.set(found.user.id);
}

/**
 * After a code sign-in that confirmed an account: ends what Better Auth's
 * strip leaves, every way in but the session just made.
 */
export async function afterCodeSignIn(database: Database, context: AuthContext): Promise<void> {
  const userId = await confirmingByCode.get();
  const returned = context.context.returned as { token?: unknown; user?: { id?: unknown } };
  if (userId === undefined || returned?.user?.id !== userId || typeof returned.token !== "string") {
    return;
  }
  await endAccountAccess(database, { userId, keep: returned.token });
}

/**
 * What hands a credential to something besides the signed-in session: a
 * device's token (the CLI), or a connection's grant. An unconfirmed account
 * may not, as such a credential could outlive the account changing hands
 * (ADR 0063: nothing another person could inherit).
 */
const GRANTS: ReadonlySet<string> = new Set([
  "/device/approve",
  "/oauth2/authorize",
  "/oauth2/continue",
  "/oauth2/consent",
]);

/** Refuses a grant from a session whose account's email is unconfirmed. */
export async function refuseUnconfirmedGrant(context: AuthContext): Promise<void> {
  if (!GRANTS.has(context.path)) return;
  const session = await getSessionFromCtx(context);
  if (!session || session.user.emailVerified) return;
  throw new APIError("FORBIDDEN", {
    code: "EMAIL_UNCONFIRMED",
    message: "Confirm your email with a code sent there before connecting a tool or an app.",
  });
}
