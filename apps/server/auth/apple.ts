// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeJwt, importPKCS8, SignJWT } from "jose";

import { describeError } from "../logging.ts";

// Sign in with Apple for the native apps (ADR 0062): which addresses Apple
// controls, and its authorization kept revocable through Apple's REST API,
// which Better Auth's ID-token sign-in does not call.

/** The installation's Apple developer credentials; the apps ship only their bundle IDs. */
export type AppleConfig = {
  /** The apps' bundle IDs, each an ID token's audience and a code's client ID. */
  bundleIds: readonly string[];
  teamId: string;
  keyId: string;
  /** The Sign in with Apple key, a PKCS #8 PEM. */
  privateKey: string;
};

/**
 * Apple's own mail domains, and Hide My Email's relay: the mailboxes Apple
 * controls, so its verification proves who holds them now (ADR 0062). Any
 * other address Apple verified once, and may since have changed hands.
 */
const APPLE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "icloud.com",
  "me.com",
  "mac.com",
  "privaterelay.appleid.com",
]);

/** Whether `email`'s domain is exactly one of those: a lookalike such as `noticloud.com` is anyone's. */
export function isAppleMailbox(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  return at > 0 && APPLE_MAIL_DOMAINS.has(email.slice(at + 1).toLowerCase());
}

/** Apple's `email_verified` claim, a boolean or its string. */
export function isAppleEmailVerified(profile: { email_verified?: unknown } | undefined): boolean {
  const claim = profile?.email_verified;
  return claim === true || claim === "true";
}

const APPLE = "https://appleid.apple.com";

/** The client secret Apple's REST API takes: a short-lived JWT signed with the team's key. */
async function clientSecret(config: AppleConfig, clientId: string): Promise<string> {
  const key = await importPKCS8(config.privateKey, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(clientId)
    .setAudience(APPLE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${APPLE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Exchanges an authorization code the app sent for a refresh token, kept only
 * if Apple's answer names `subject`, the identity whose ID token was verified:
 * a code from another sign-in must not bind its authorization here.
 * `undefined` on any failure, logged without the code or a token.
 */
export async function exchangeAppleCode(
  config: AppleConfig,
  input: { clientId: string; code: string; subject: string },
): Promise<string | undefined> {
  try {
    const response = await post("/auth/token", {
      client_id: input.clientId,
      client_secret: await clientSecret(config, input.clientId),
      code: input.code,
      grant_type: "authorization_code",
    });
    if (!response.ok) {
      console.warn(`[Apple] The code exchange answered ${response.status}; no token kept.`);
      return undefined;
    }
    const answer = (await response.json()) as { refresh_token?: unknown; id_token?: unknown };
    // From Apple over TLS, as Better Auth's own exchange takes it: decoded only.
    const subject =
      typeof answer.id_token === "string" ? decodeJwt(answer.id_token).sub : undefined;
    if (subject !== input.subject || typeof answer.refresh_token !== "string") {
      console.warn("[Apple] The code exchange named another identity, or no token; none kept.");
      return undefined;
    }
    return answer.refresh_token;
  } catch (error) {
    console.warn(`[Apple] The code exchange failed; no token kept: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Revokes a refresh token at Apple, ending the person's authorization of the
 * app (ADR 0062). Whether Apple accepted it; a failure is logged.
 */
export async function revokeAppleToken(
  config: AppleConfig,
  input: { clientId: string; refreshToken: string },
): Promise<boolean> {
  try {
    const response = await post("/auth/revoke", {
      client_id: input.clientId,
      client_secret: await clientSecret(config, input.clientId),
      token: input.refreshToken,
      token_type_hint: "refresh_token",
    });
    if (response.ok) return true;
    console.warn(`[Apple] Revoking a token answered ${response.status}.`);
    return false;
  } catch (error) {
    console.warn(`[Apple] Revoking a token failed: ${describeError(error)}`);
    return false;
  }
}
