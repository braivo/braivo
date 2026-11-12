// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { createApi } from "./app.ts";
import { hashed, idTokenContract } from "./id-token-contract.ts";

// The native apps' sign-in with Google's ID token (ADR 0062, access-30),
// through the mount. Google is stood in for by a key of the test's own, its
// public half served where Better Auth fetches Google's keys: verification is
// Better Auth's own, unchanged.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const outbox = createOutbox();
const google = { clientId: "native-test-web-client", clientSecret: "native-test-secret" };
const auth = createAuth({
  database,
  secret: "native-sign-in-test-secret-long-enough",
  baseURL: baseUrl,
  sendMail: outbox.sendMail,
  google,
});
const api = createApi({ auth, database, baseUrl, sendMail: outbox.sendMail });

const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const googleKey = await generateKeyPair("RS256", { extractable: true });
/** A key Google does not hold, under the same `kid`: a forged signature. */
const forgerKey = await generateKeyPair("RS256", { extractable: true });
const KID = "native-test-key";

const realFetch = globalThis.fetch;
const jwksRequests: string[] = [];
async function serveGoogleKeys() {
  const jwk = { ...(await exportJWK(googleKey.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== GOOGLE_KEYS) return realFetch(input, init);
    jwksRequests.push(url);
    return Promise.resolve(Response.json({ keys: [jwk] }));
  });
}

/** Fresh each run, so a rerun never meets a leftover account. */
const emails: string[] = [];
function newEmail(domain = "gmail.com"): string {
  const email = `native-test-${crypto.randomUUID()}@${domain}`;
  emails.push(email);
  return email;
}

/** An ID token as Google signs one for the apps, `claims` overriding a valid one's. */
function googleToken(
  claims: JWTPayload & Record<string, unknown>,
  options: { key?: CryptoKey; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({
    sub: crypto.randomUUID(),
    email_verified: true,
    name: "Grace Hopper",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(typeof claims.iss === "string" ? claims.iss : "https://accounts.google.com")
    .setAudience(claims.aud ?? google.clientId)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(options.key ?? googleKey.privateKey);
}

const json = (headers: Record<string, string> = {}) => ({
  "content-type": "application/json",
  ...headers,
});

function askForNonce(headers: Record<string, string> = json(), url = "/api/sign-in/nonce") {
  return api.request(url, { method: "POST", headers, body: "{}" });
}

async function newNonce(): Promise<string> {
  const response = await askForNonce();
  expect(response.status).toBe(201);
  return ((await response.json()) as { nonce: string }).nonce;
}

function signInWithToken(idToken: Record<string, unknown>) {
  return api.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ provider: "google", idToken }),
  });
}

/** A whole native sign-in: a nonce, then Google's token carrying its hash. */
async function signInWithGoogle(claims: JWTPayload & Record<string, unknown>) {
  const nonce = await newNonce();
  const token = await googleToken({ nonce: hashed(nonce), ...claims });
  return { response: await signInWithToken({ token, nonce }), token, nonce };
}

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((set) => set.split(";", 1)[0])
    .join("; ");

const userByEmail = async (email: string) =>
  (await database.select().from(authTables.user).where(eq(authTables.user.email, email)))[0];

/** Requires TEST_DATABASE_URL: accounts and nonces live in the real schema. */
describe.skipIf(!connectionString)("a native app signing in with Google's ID token", () => {
  idTokenContract({
    provider: "google",
    api,
    database,
    serveKeys: serveGoogleKeys,
    newEmail: () => newEmail(),
    token: (claims, broken = {}) =>
      googleToken(
        {
          ...claims,
          ...(broken.issuer && { iss: broken.issuer }),
          ...(broken.audience && { aud: broken.audience }),
        },
        { expiresIn: broken.expiresIn, key: broken.forged ? forgerKey.privateKey : undefined },
      ),
  });

  beforeAll(() => runMigrations(connectionString ?? ""));
  afterEach(() => void vi.restoreAllMocks());
  afterAll(async () => {
    if (emails.length > 0) {
      await database.delete(authTables.user).where(inArray(authTables.user.email, emails));
    }
  });

  describe("asking for a nonce", () => {
    test("answers a fresh one, good for ten minutes", async () => {
      const before = Date.now();
      const response = await askForNonce();
      const body = (await response.json()) as { nonce: string; expiresAt: string };

      expect(response.status).toBe(201);
      expect(body.nonce).toMatch(/^[\w-]{43}$/);
      expect(new Date(body.expiresAt).getTime() - before).toBeGreaterThanOrEqual(599_000);
      expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
      expect(await newNonce()).not.toBe(body.nonce);
    });

    test("stores only its hash, the token's claim, never what redeems it", async () => {
      const nonce = await newNonce();
      const rows = await database
        .select()
        .from(authTables.verification)
        .where(eq(authTables.verification.id, `sign-in-nonce:${hashed(nonce)}`));

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(nonce);
    });

    test("is a JSON write from the installation's own origin, or none", async () => {
      expect((await askForNonce(json({ origin: baseUrl }))).status).toBe(201);
      expect((await askForNonce(json({ origin: "https://evil.example" }))).status).toBe(403);
      expect((await askForNonce({ "content-type": "text/plain" })).status).toBe(403);
    });
    // On a learn domain, 404: policy.test.ts.
  });

  test("makes a verified, named account for a Gmail address, and signs it in by cookie", async () => {
    await serveGoogleKeys();
    const email = newEmail();
    const { response } = await signInWithGoogle({ email });
    const body = (await response.json()) as { user: { email: string; name: string } };

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({ email, name: "Grace Hopper" });
    expect(await userByEmail(email)).toMatchObject({ emailVerified: true, name: "Grace Hopper" });
    expect(jwksRequests).toContain(GOOGLE_KEYS);
    const session = await api.request("/api/session", {
      headers: { cookie: cookiesOf(response) },
    });
    expect(session.status).toBe(200);
  });

  test("signs in again by the same Google account, into the same account", async () => {
    await serveGoogleKeys();
    const email = newEmail();
    const sub = crypto.randomUUID();
    const first = await signInWithGoogle({ email, sub });
    const again = await signInWithGoogle({ email, sub });

    expect(again.response.status).toBe(200);
    const ids = [first.response, again.response].map(
      async (r) => ((await r.json()) as { user: { id: string } }).user.id,
    );
    expect(await ids[1]).toBe(await ids[0]);
  });

  test("refuses, as Google's redirect does, an address Google is not authoritative for or has not verified", async () => {
    await serveGoogleKeys();
    const school = newEmail("school.example");
    const unverified = newEmail();
    const notAuthoritative = await signInWithGoogle({ email: school });
    const notVerified = await signInWithGoogle({ email: unverified, email_verified: false });

    expect(notAuthoritative.response.status).toBe(403);
    expect(await codeOf(notAuthoritative.response)).toBe("email_not_authoritative");
    expect(notVerified.response.status).toBe(403);
    expect(await codeOf(notVerified.response)).toBe("email_not_verified");
    expect(await userByEmail(school)).toBeUndefined();
    expect(await userByEmail(unverified)).toBeUndefined();
  });

  test("refuses a Google account whose email changed since it made the account", async () => {
    await serveGoogleKeys();
    const sub = crypto.randomUUID();
    const first = await signInWithGoogle({ email: newEmail(), sub });
    const renamed = await signInWithGoogle({ email: newEmail(), sub });

    expect(first.response.status).toBe(200);
    expect(renamed.response.status).toBe(403);
    expect(await codeOf(renamed.response)).toBe("email_changed");
  });

  test("names an account a code made with no name, and renames none", async () => {
    await serveGoogleKeys();
    const request = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);
    const unnamed = newEmail();
    const named = newEmail();
    await signInWithCode(request, outbox, { email: unnamed });
    await signInWithCode(request, outbox, { email: named, name: "Ada" });

    const filled = await signInWithGoogle({ email: unnamed });
    const kept = await signInWithGoogle({ email: named });

    expect(((await filled.response.json()) as { user: { name: string } }).user.name).toBe(
      "Grace Hopper",
    );
    expect((await userByEmail(unnamed))?.name).toBe("Grace Hopper");
    expect(kept.response.status).toBe(200);
    expect((await userByEmail(named))?.name).toBe("Ada");
  });

  test("keeps no access or refresh token the app sends beside the ID token, new account or not", async () => {
    await serveGoogleKeys();
    const email = newEmail();
    const sub = crypto.randomUUID();
    /** Signs in carrying recognizable tokens beside the ID token. */
    const carrying = async () => {
      const nonce = await newNonce();
      const token = await googleToken({ email, sub, nonce: hashed(nonce) });
      return signInWithToken({
        token,
        nonce,
        accessToken: "client-access-token",
        refreshToken: "client-refresh-token",
        expiresAt: Date.now() + 3_600_000,
      });
    };
    const googleAccount = async () => {
      const user = await userByEmail(email);
      const rows = await database
        .select()
        .from(authTables.account)
        .where(
          and(eq(authTables.account.userId, user!.id), eq(authTables.account.providerId, "google")),
        );
      return rows[0];
    };

    // Made by this sign-in, then signed in to again: Better Auth writes the
    // body's tokens on both paths unless they are gone.
    expect((await carrying()).status).toBe(200);
    expect(await googleAccount()).toMatchObject({ accessToken: null, refreshToken: null });
    expect((await carrying()).status).toBe(200);
    expect(await googleAccount()).toMatchObject({
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
    });
  });
});
