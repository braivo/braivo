// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineRequestState } from "@better-auth/core/context";
import type { Database } from "@braivo/db";
import { APIError, type createAuthMiddleware } from "better-auth/api";
import { symmetricEncrypt } from "better-auth/crypto";
import { decodeJwt } from "jose";

import { redeemSignInNonce } from "../application/sign-in-nonce.ts";
import { keepAppleRefreshToken, nameUnnamedUser } from "../persistence/index.ts";
import { type AppleOptions, bindAppleIdentity, refuseWithAppleLink } from "./apple-link.ts";
import { type AppleConfig, exchangeAppleCode } from "./apple.ts";

// The native apps' sign-in with a provider's ID token (ADR 0062), around
// Better Auth's `/sign-in/social`: its nonce before, Apple's authorization
// and the account's name after.

/** What a Better Auth hook is given. */
type AuthContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * The authorization code an Apple sign-in carries beside its token, kept from
 * the raw body for the after hook: Better Auth's body has no place for it.
 */
const appleAuthorizationCode = defineRequestState((): string | undefined => undefined);

/**
 * Before `/sign-in/social`. Apple signs in by ID token alone: its redirect
 * would need a Services ID and a callback Braivo has no use for (ADR 0062).
 *
 * Spends the nonce an ID token carries before Better Auth verifies anything,
 * so a refused token spends it too, and puts its hash in its place: the
 * token's claim is that hash, compared exactly. Without a nonce Better Auth
 * would compare none, and a token would sign in until it expired. Apple's
 * provider also accepts a claim that is the hash of that hash
 * (`exact-or-sha256`): harmless, as the raw nonce is still redeemed once.
 *
 * The tokens a client sends beside it are dropped: Braivo uses no provider's
 * access token, and keeps none it did not get from the provider itself
 * (Apple's refresh token is exchanged for, below). Deleted from the body
 * itself, as the endpoint validates it after this: a body returned from here
 * would be merged into the original (`defu`), keeping them.
 */
export async function beforeIdTokenSignIn(database: Database, body: unknown): Promise<void> {
  const { provider, idToken, authorizationCode } = (body ?? {}) as Record<string, unknown>;
  if (provider === "apple" && idToken === undefined) {
    throw new APIError("BAD_REQUEST", {
      code: "ID_TOKEN_REQUIRED",
      message: "Apple signs in with its ID token alone.",
    });
  }
  if (typeof idToken !== "object" || idToken === null) return;
  const sent = idToken as Record<string, unknown>;
  if (typeof sent.nonce !== "string" || sent.nonce === "") {
    throw new APIError("BAD_REQUEST", {
      code: "NONCE_REQUIRED",
      message: "Ask for a nonce first, and send it with the ID token.",
    });
  }
  const hash = await redeemSignInNonce({ database, nonce: sent.nonce, now: new Date() });
  if (!hash) {
    throw new APIError("UNAUTHORIZED", {
      code: "NONCE_INVALID",
      message: "This nonce is unknown, expired, or spent. Ask for a new one and sign in again.",
    });
  }
  sent.nonce = hash;
  delete sent.accessToken;
  delete sent.refreshToken;
  delete sent.expiresAt;
  if (provider === "apple" && typeof authorizationCode === "string" && authorizationCode !== "") {
    await appleAuthorizationCode.set(authorizationCode);
  }
  delete (body as Record<string, unknown>).authorizationCode;
}

/**
 * After `/sign-in/social` by ID token: Apple's refusal of an address another
 * account holds answered with a link by code; a sign-in's Apple binding and
 * authorization kept; then the account's name filled.
 */
export async function afterIdTokenSignIn(options: AppleOptions, context: AuthContext) {
  const returned = context.context.returned as
    | { token?: unknown; user?: { id?: unknown; name?: unknown } }
    | undefined;
  const body = (context.body ?? {}) as {
    provider?: unknown;
    idToken?: { token?: unknown; user?: { name?: { firstName?: unknown; lastName?: unknown } } };
  };
  const given = (claims: Record<string, unknown>) =>
    body.provider === "apple"
      ? [body.idToken?.user?.name?.firstName, body.idToken?.user?.name?.lastName]
          .filter((part): part is string => typeof part === "string")
          .join(" ")
      : claims.name;
  if (typeof body.idToken?.token !== "string") return;
  if (
    body.provider === "apple" &&
    returned instanceof APIError &&
    returned.body?.code === "OAUTH_LINK_ERROR" &&
    returned.body.message === "account not linked"
  ) {
    // Better Auth refuses so only once the token is verified. Its message is
    // the only mark of this refusal (a literal in its `link-account.ts`, no
    // constant); the linking tests fail if an upgrade changes it.
    const claims = decodeJwt(body.idToken.token);
    const name = given(claims);
    return refuseWithAppleLink(options, {
      claims,
      code: await appleAuthorizationCode.get(),
      name: typeof name === "string" ? name.trim() : "",
    });
  }
  const user = returned?.user;
  if (typeof user?.id !== "string") return;
  // Verified by Better Auth by now.
  const claims = decodeJwt(body.idToken.token);

  if (body.provider === "apple" && typeof claims.sub === "string") {
    await assertBound(options, context, {
      subject: claims.sub,
      userId: user.id,
      sessionToken: returned?.token,
    });
    const code = await appleAuthorizationCode.get();
    const clientId = typeof claims.aud === "string" ? claims.aud : undefined;
    if (options.apple && code && clientId) {
      await keepAppleAuthorization(
        { ...options, apple: options.apple },
        { subject: claims.sub, clientId, code },
      );
    }
  }

  return fillEmptyName(options.database, context, { userId: user.id, name: given(claims) });
}

/**
 * Keeps the Apple identity this sign-in used the account's one (ADR 0063),
 * under the account's lock, ending what another identity's left; or refuses
 * the session just made if it is no longer the account's: a confirmation
 * elsewhere, or another link, unlinked it meanwhile. Those delete the link
 * before the account's sessions, so either their session delete catches this
 * one, made before it, or this read, after this session was made, finds the
 * link gone.
 */
async function assertBound(
  options: AppleOptions,
  context: AuthContext,
  input: { subject: string; userId: string; sessionToken: unknown },
): Promise<void> {
  const keep = typeof input.sessionToken === "string" ? input.sessionToken : undefined;
  if (await bindAppleIdentity(options, { ...input, keep })) return;
  if (keep) await context.context.internalAdapter.deleteSession(keep);
  throw new APIError("UNAUTHORIZED", {
    code: "APPLE_UNLINKED",
    message: "This Apple ID was unlinked from the account meanwhile. Sign in again.",
  });
}

/**
 * Exchanges the sign-in's authorization code for a refresh token, so erasure
 * can end the person's authorization at Apple (ADR 0062), on every sign-in
 * carrying one, replacing the token kept, never revoking it: revoking ends the
 * person's authorization for the app, the new one's included. Kept encrypted,
 * beside the client ID it was issued to, which revoking it needs. A failed
 * exchange keeps what was kept.
 */
async function keepAppleAuthorization(
  options: AppleOptions & { apple: AppleConfig },
  input: { subject: string; clientId: string; code: string },
): Promise<void> {
  const refreshToken = await exchangeAppleCode(options.apple, input);
  if (!refreshToken) return;
  await keepAppleRefreshToken(options.database, {
    subject: input.subject,
    refreshToken: await symmetricEncrypt({ key: options.secret, data: refreshToken }),
    clientId: input.clientId,
    at: new Date(),
  });
}

/**
 * Names an account that has no name yet with the one its provider gave (ADR
 * 0062, access-5): never renaming, which Better Auth's `updateUserInfoOnLink`
 * would. A new account is named by Better Auth already.
 */
async function fillEmptyName(
  database: Database,
  context: AuthContext,
  input: { userId: string; name: unknown },
) {
  const returned = context.context.returned as { user: Record<string, unknown> };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "" || returned.user.name !== "") return;
  if (!(await nameUnnamedUser(database, { userId: input.userId, name, at: new Date() }))) return;
  return context.json({ ...returned, user: { ...returned.user, name } });
}
