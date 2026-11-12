// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { exportJWK, exportPKCS8, generateKeyPair, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import type { AppleConfig } from "../auth/apple.ts";
import { createAuth, revokeAppleAuthorizationsOf } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { createApi } from "./app.ts";
import { hashed, idTokenContract } from "./id-token-contract.ts";

// The native apps' Sign in with Apple (ADR 0062, access-30), through the
// mount. Apple is stood in for at its three endpoints: its keys, which
// Better Auth verifies tokens against unchanged, and the token and revoke
// endpoints Braivo calls.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const outbox = createOutbox();
const secret = "apple-sign-in-test-secret-long-enough";

/** Apple's signing key for ID tokens, and the team's key for client secrets. */
const appleKey = await generateKeyPair("RS256", { extractable: true });
/** A key Apple does not hold, under the same `kid`: a forged signature. */
const forgerKey = await generateKeyPair("RS256", { extractable: true });
const teamKey = await generateKeyPair("ES256", { extractable: true });
const KID = "apple-test-key";
const apple: AppleConfig = {
  bundleIds: ["app.example.learn", "app.example.learn.ipad"],
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: await exportPKCS8(teamKey.privateKey),
};
const auth = createAuth({ database, secret, baseURL: baseUrl, sendMail: outbox.sendMail, apple });
const api = createApi({ auth, database, baseUrl, sendMail: outbox.sendMail });

type Call = { path: string; form: URLSearchParams };
const calls: Call[] = [];
/** What Apple's token endpoint answers next: a subject and a refresh token, or a status. */
let tokenAnswer: { sub: string; refreshToken: string } | number = 400;
let revokeStatus = 200;

const realFetch = globalThis.fetch;
async function standInForApple() {
  const jwk = { ...(await exportJWK(appleKey.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://appleid.apple.com/auth/keys") return Response.json({ keys: [jwk] });
    if (
      url === "https://appleid.apple.com/auth/token" ||
      url === "https://appleid.apple.com/auth/revoke"
    ) {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      calls.push({ path: new URL(url).pathname, form });
      if (url.endsWith("/revoke")) return new Response(null, { status: revokeStatus });
      if (typeof tokenAnswer === "number") return new Response(null, { status: tokenAnswer });
      const idToken = await new SignJWT({ sub: tokenAnswer.sub })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .sign(appleKey.privateKey);
      return Response.json({
        access_token: "apple-access",
        refresh_token: tokenAnswer.refreshToken,
        id_token: idToken,
      });
    }
    return realFetch(input, init);
  });
}

const emails: string[] = [];
function newEmail(domain = "icloud.com"): string {
  const email = `apple-test-${crypto.randomUUID()}@${domain}`;
  emails.push(email);
  return email;
}

/** An ID token as Apple signs one for the apps, valid but for what `broken` asks. */
function appleToken(
  claims: JWTPayload & Record<string, unknown>,
  broken: { issuer?: string; expiresIn?: string; forged?: boolean; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ sub: crypto.randomUUID(), email_verified: "true", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(broken.issuer ?? "https://appleid.apple.com")
    .setAudience(broken.audience ?? claims.aud ?? apple.bundleIds[0]!)
    .setIssuedAt()
    .setExpirationTime(broken.expiresIn ?? "10m")
    .sign(broken.forged ? forgerKey.privateKey : appleKey.privateKey);
}

const json = { "content-type": "application/json" };

async function newNonce(): Promise<string> {
  const response = await api.request("/api/sign-in/nonce", {
    method: "POST",
    headers: json,
    body: "{}",
  });
  return ((await response.json()) as { nonce: string }).nonce;
}

/**
 * A whole Apple sign-in: a nonce, then Apple's token carrying its hash, with
 * what the app sends beside it.
 */
async function signInWithApple(
  claims: JWTPayload & Record<string, unknown>,
  extra: { authorizationCode?: string; user?: unknown } = {},
) {
  const nonce = await newNonce();
  const token = await appleToken({ nonce: hashed(nonce), ...claims });
  return api.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      provider: "apple",
      idToken: { token, nonce, ...(extra.user !== undefined && { user: extra.user }) },
      ...(extra.authorizationCode && { authorizationCode: extra.authorizationCode }),
    }),
  });
}

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;
const userIdOf = async (response: Response) =>
  ((await response.json()) as { user: { id: string } }).user.id;
const userByEmail = async (email: string) =>
  (await database.select().from(authTables.user).where(eq(authTables.user.email, email)))[0];
const appleAccount = async (subject: string) =>
  (
    await database
      .select()
      .from(authTables.account)
      .where(
        and(eq(authTables.account.providerId, "apple"), eq(authTables.account.accountId, subject)),
      )
  )[0];

/** Requires TEST_DATABASE_URL: accounts and nonces live in the real schema. */
describe.skipIf(!connectionString)("a native app signing in with Apple", () => {
  beforeAll(() => runMigrations(connectionString ?? ""));
  afterEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    tokenAnswer = 400;
    revokeStatus = 200;
  });
  afterAll(async () => {
    if (emails.length > 0) {
      await database.delete(authTables.user).where(inArray(authTables.user.email, emails));
    }
  });

  idTokenContract({
    provider: "apple",
    api,
    database,
    serveKeys: standInForApple,
    newEmail: () => newEmail(),
    token: (claims, broken) => appleToken(claims, broken),
  });

  test("is offered by an installation with Apple's key, by ID token alone", async () => {
    const settings = await api.request("/api/sign-in-settings");
    const redirect = await api.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ provider: "apple", callbackURL: "/" }),
    });

    expect(await settings.json()).toMatchObject({ apple: true });
    expect(redirect.status).toBe(400);
    expect(await codeOf(redirect)).toBe("ID_TOKEN_REQUIRED");
  });

  test.each([
    ["an iCloud address", "icloud.com"],
    ["a me.com address", "me.com"],
    ["a mac.com address", "mac.com"],
    ["a Hide My Email address", "privaterelay.appleid.com"],
  ])("makes a verified account for %s, named the first time", async (_, domain) => {
    await standInForApple();
    const email = newEmail(domain);
    const response = await signInWithApple(
      { email },
      { user: { name: { firstName: "Grace", lastName: "Hopper" } } },
    );

    expect(response.status).toBe(200);
    expect(await userByEmail(email)).toMatchObject({ emailVerified: true, name: "Grace Hopper" });
  });

  test("accepts each of the apps' bundle IDs as the audience, and no other", async () => {
    await standInForApple();
    const ipad = await signInWithApple({ email: newEmail(), aud: "app.example.learn.ipad" });
    const email = newEmail();
    const other = await signInWithApple({ email, aud: "app.example.elsewhere" });

    expect(ipad.status).toBe(200);
    expect(other.status).toBe(401);
    expect(await codeOf(other)).toBe("INVALID_TOKEN");
    expect(await userByEmail(email)).toBeUndefined();
  });

  test("signs in again by its subject whatever address its token now carries, the account's kept", async () => {
    await standInForApple();
    const email = newEmail("privaterelay.appleid.com");
    const sub = crypto.randomUUID();
    const first = await signInWithApple({ email, sub });
    const shared = await signInWithApple({ email: newEmail("school.example"), sub });
    // Apple may not vouch for a Work & School account's address: the identity still signs in.
    const unvouched = await signInWithApple({ email: newEmail(), sub, email_verified: false });

    expect(shared.status).toBe(200);
    expect(unvouched.status).toBe(200);
    const id = await userIdOf(first);
    expect(await userIdOf(shared)).toBe(id);
    expect(await userIdOf(unvouched)).toBe(id);
    expect(await userByEmail(email)).toMatchObject({ id, emailVerified: true });
  });

  test("links to the account a code made for its iCloud address, naming it if unnamed", async () => {
    await standInForApple();
    const email = newEmail();
    const request = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);
    const { id } = await signInWithCode(request, outbox, { email });
    const response = await signInWithApple(
      { email },
      { user: { name: { firstName: "Ada", lastName: "" } } },
    );

    expect(response.status).toBe(200);
    expect(await userIdOf(response)).toBe(id);
    expect((await userByEmail(email))?.name).toBe("Ada");
  });

  test.each([
    ["school.example"],
    // Only the exact domains: lookalikes are anyone's.
    ["noticloud.com"],
    ["icloud.com.example"],
  ])(
    "makes an account on %s, which Apple does not control, its email unconfirmed (access-61)",
    async (domain) => {
      await standInForApple();
      const email = newEmail(domain);
      const response = await signInWithApple({ email });

      expect(response.status).toBe(200);
      expect(await userByEmail(email)).toMatchObject({ emailVerified: false });
    },
  );

  test.each([
    ["false", false],
    ['"false"', "false"],
    ["missing", undefined],
  ])("refuses an address Apple's email_verified calls %s, making nothing", async (_, claim) => {
    await standInForApple();
    const email = newEmail();
    const response = await signInWithApple({ email, email_verified: claim });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("email_not_verified");
    expect(await userByEmail(email)).toBeUndefined();
  });

  describe("its authorization, kept revocable", () => {
    test("exchanges the code for its own subject, keeping the token encrypted with its client ID", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      tokenAnswer = { sub, refreshToken: "apple-refresh-1" };
      const response = await signInWithApple(
        { email: newEmail(), sub, aud: "app.example.learn.ipad" },
        { authorizationCode: "code-1" },
      );

      expect(response.status).toBe(200);
      const [exchange] = calls;
      expect(exchange?.path).toBe("/auth/token");
      expect(exchange?.form.get("code")).toBe("code-1");
      expect(exchange?.form.get("client_id")).toBe("app.example.learn.ipad");
      expect(exchange?.form.get("grant_type")).toBe("authorization_code");
      const { payload, protectedHeader } = await jwtVerify(
        exchange?.form.get("client_secret") ?? "",
        teamKey.publicKey,
        {
          issuer: apple.teamId,
          audience: "https://appleid.apple.com",
          subject: "app.example.learn.ipad",
        },
      );
      expect(protectedHeader.kid).toBe(apple.keyId);
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
      const kept = await appleAccount(sub);
      expect(kept?.refreshToken).toBeTruthy();
      expect(kept?.refreshToken).not.toContain("apple-refresh-1");
      expect(kept?.refreshTokenClientId).toBe("app.example.learn.ipad");
    });

    test("replaces the token on each sign-in with a code, revoking none", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      const email = newEmail();
      tokenAnswer = { sub, refreshToken: "apple-refresh-1" };
      await signInWithApple({ email, sub }, { authorizationCode: "code-1" });
      const first = (await appleAccount(sub))?.refreshToken;
      tokenAnswer = { sub, refreshToken: "apple-refresh-2" };
      await signInWithApple({ email, sub }, { authorizationCode: "code-2" });

      expect((await appleAccount(sub))?.refreshToken).not.toBe(first);
      expect(calls.map(({ path }) => path)).toEqual(["/auth/token", "/auth/token"]);
    });

    test("keeps no token Apple issued to another subject, or when Apple refuses, and signs in either way", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      const email = newEmail();
      tokenAnswer = { sub: "someone-else", refreshToken: "theirs" };
      const mismatched = await signInWithApple({ email, sub }, { authorizationCode: "code-1" });
      tokenAnswer = 400;
      const refused = await signInWithApple({ email, sub }, { authorizationCode: "code-2" });

      expect([mismatched.status, refused.status]).toEqual([200, 200]);
      expect((await appleAccount(sub))?.refreshToken).toBeNull();
    });

    test("keeps the token kept when a later exchange fails", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      const email = newEmail();
      tokenAnswer = { sub, refreshToken: "apple-refresh-1" };
      await signInWithApple({ email, sub }, { authorizationCode: "code-1" });
      const kept = (await appleAccount(sub))?.refreshToken;
      tokenAnswer = 400;
      await signInWithApple({ email, sub }, { authorizationCode: "code-2" });

      expect((await appleAccount(sub))?.refreshToken).toBe(kept);
    });

    test("revokes the token when the Apple identity is unlinked, with the client ID it was issued to", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      tokenAnswer = { sub, refreshToken: "apple-refresh-1" };
      await signInWithApple(
        { email: newEmail(), sub, aud: "app.example.learn.ipad" },
        { authorizationCode: "c" },
      );
      const row = await appleAccount(sub);

      await (await auth.$context).internalAdapter.deleteAccount(row!.id);

      const revoke = calls.find(({ path }) => path === "/auth/revoke");
      expect(revoke?.form.get("token")).toBe("apple-refresh-1");
      expect(revoke?.form.get("token_type_hint")).toBe("refresh_token");
      expect(revoke?.form.get("client_id")).toBe("app.example.learn.ipad");
    });

    test("revokes at erasure, saying when it could not", async () => {
      await standInForApple();
      const sub = crypto.randomUUID();
      const email = newEmail();
      tokenAnswer = { sub, refreshToken: "apple-refresh-1" };
      const signedIn = await signInWithApple({ email, sub }, { authorizationCode: "c" });
      const userId = await userIdOf(signedIn);
      const options = { database, secret, apple };

      expect(await revokeAppleAuthorizationsOf(options, { userId, email })).toBe("revoked");
      revokeStatus = 400;
      expect(await revokeAppleAuthorizationsOf(options, { userId, email })).toBe("not revoked");
      expect(await revokeAppleAuthorizationsOf({ database, secret }, { userId, email })).toBe(
        "not revoked",
      );
      const request = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);
      const byCode = await signInWithCode(request, outbox, { email: newEmail() });
      expect(await revokeAppleAuthorizationsOf(options, { userId: byCode.id, email })).toBe("none");
    });
  });

  test("refuses the session it made if the Apple identity was unlinked meanwhile", async () => {
    await standInForApple();
    const sub = crypto.randomUUID();
    const email = newEmail();
    expect((await signInWithApple({ email, sub })).status).toBe(200);
    // A confirmation elsewhere unlinks the identity after Better Auth found
    // it, before this sign-in's session is made.
    const { internalAdapter } = await auth.$context;
    const createSession = internalAdapter.createSession.bind(internalAdapter);
    vi.spyOn(internalAdapter, "createSession").mockImplementationOnce(async (...args) => {
      await database
        .delete(authTables.account)
        .where(
          and(eq(authTables.account.providerId, "apple"), eq(authTables.account.accountId, sub)),
        );
      return createSession(...args);
    });

    const response = await signInWithApple({ email, sub });
    const cookie = response.headers
      .getSetCookie()
      .map((set) => set.split(";", 1)[0])
      .join("; ");

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("APPLE_UNLINKED");
    const user = await userByEmail(email);
    expect(await database.$count(authTables.session, eq(authTables.session.userId, user!.id))).toBe(
      1,
    );
    expect((await api.request("/api/session", { headers: { cookie } })).status).toBe(401);
  });
});
