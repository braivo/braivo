// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import { runMigrations } from "@braivo/db";
import * as schema from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { exportJWK, exportPKCS8, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import {
  exportLearner,
  previewAccountErasure,
  previewHistoryErasure,
  registerLearnDomain,
} from "../application/index.ts";
import { previewOwnerPromotion } from "../application/members.ts";
import { bindAppleIdentity } from "../auth/apple-link.ts";
import type { AppleConfig } from "../auth/apple.ts";
import {
  addMember,
  createAuth,
  createOrganization,
  removeReviewerPassword,
  revokeAppleAuthorizationsOf,
  setReviewerPassword,
} from "../auth/index.ts";
import { codeSentTo, createOutbox, signInWithCode } from "../auth/testing.ts";
import { createApi } from "./app.ts";
import { hashed } from "./id-token-contract.ts";

// An Apple identity on an address Apple does not control (ADR 0063), through
// the mount: it signs in, confirms nothing, reaches nothing an email names,
// and loses its link when someone else proves the mailbox first.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const outbox = createOutbox();
const secret = "unconfirmed-email-test-secret-long-enough";
const selfServeDomain = "unconfirmed-test.example";

const providerKey = await generateKeyPair("RS256", { extractable: true });
const teamKey = await generateKeyPair("ES256", { extractable: true });
const KID = "unconfirmed-test-key";
const apple: AppleConfig = {
  bundleIds: ["app.example.learn"],
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: await exportPKCS8(teamKey.privateKey),
};
const google = { clientId: "unconfirmed-test-web-client", clientSecret: "secret" };
const auth = createAuth({
  database,
  secret,
  baseURL: baseUrl,
  sendMail: outbox.sendMail,
  apple,
  google,
});
const api = createApi({ auth, database, baseUrl, sendMail: outbox.sendMail, selfServeDomain });

/** What reached Apple's revoke endpoint: the tokens revoked, or asked to be. */
const revoked: string[] = [];
/** Tokens Apple refuses to revoke. */
const refusedRevocations = new Set<string>();
const realFetch = globalThis.fetch;
async function standInForProviders() {
  const jwk = { ...(await exportJWK(providerKey.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://appleid.apple.com/auth/keys") return Response.json({ keys: [jwk] });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    if (url === "https://appleid.apple.com/auth/revoke") {
      const token = new URLSearchParams(init?.body as URLSearchParams).get("token") ?? "";
      revoked.push(token);
      return new Response(null, { status: refusedRevocations.has(token) ? 400 : 200 });
    }
    if (url === "https://appleid.apple.com/auth/token") {
      const code = new URLSearchParams(init?.body as URLSearchParams).get("code") ?? "";
      // The code names its subject here: `<sub>:<token>`.
      const [sub, refreshToken] = code.split(":");
      const idToken = await new SignJWT({ sub })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .sign(providerKey.privateKey);
      return Response.json({ refresh_token: refreshToken, id_token: idToken });
    }
    return realFetch(input, init);
  });
}

const prefix = "unconfirmed-test";
const emails: string[] = [];
function newEmail(domain = "school.example"): string {
  const email = `${prefix}-${crypto.randomUUID()}@${domain}`;
  emails.push(email);
  return email;
}

const json = { "content-type": "application/json" };
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((set) => set.split(";", 1)[0])
    .join("; ");
const codeOf = async (response: Response) =>
  ((await response.clone().json()) as { code?: string }).code;
const post = (path: string, body: unknown, cookie?: string) =>
  api.request(path, {
    method: "POST",
    headers: { ...json, origin: baseUrl, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
  });

async function newNonce(): Promise<string> {
  return ((await (await post("/api/sign-in/nonce", {})).json()) as { nonce: string }).nonce;
}

function token(provider: "apple" | "google", claims: JWTPayload & Record<string, unknown>) {
  const [iss, aud] =
    provider === "apple"
      ? ["https://appleid.apple.com", apple.bundleIds[0]!]
      : ["https://accounts.google.com", google.clientId];
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(providerKey.privateKey);
}

/** Signs in with `provider`'s token; Apple's carries a code its stand-in exchanges for `refresh-<sub>`. */
async function signInWith(provider: "apple" | "google", claims: { email: string; sub: string }) {
  const nonce = await newNonce();
  return post("/api/auth/sign-in/social", {
    provider,
    idToken: { token: await token(provider, { ...claims, nonce: hashed(nonce) }), nonce },
    ...(provider === "apple" && { authorizationCode: `${claims.sub}:refresh-${claims.sub}` }),
  });
}

/** An account Sign in with Apple made on `email`, unconfirmed, and its Apple session. */
async function unconfirmedAccount(email = newEmail()) {
  const sub = crypto.randomUUID();
  const response = await signInWith("apple", { email, sub });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  return { id: user.id, email, sub, cookie: cookiesOf(response) };
}

const userOf = async (id: string) =>
  (await database.select().from(schema.user).where(eq(schema.user.id, id)))[0];
const appleLinks = (userId: string) =>
  database.$count(
    schema.account,
    and(eq(schema.account.userId, userId), eq(schema.account.providerId, "apple")),
  );
const signedIn = async (cookie: string) =>
  (await api.request("/api/session", { headers: { cookie } })).status === 200;
/** Lets the address be sent another code at once: its minute is another test's subject (access-2). */
const forgetMinute = (email: string) =>
  database
    .delete(schema.verification)
    .where(eq(schema.verification.id, `sign-in-code-sent:${email}`));

const organizationId = `${prefix}-school`;
const learnOrigin = "https://learn.unconfirmed-test.example";

/** How a link's ID is stored: its hash, as `auth/apple-link.ts` keys it. */
const linkHash = (linkId: string) => createHash("sha256").update(linkId).digest("base64url");

/** Ways into the account a confirmation elsewhere or a replaced Apple identity must end, besides sessions. */
async function otherWaysIn(userId: string) {
  const expiresAt = new Date(Date.now() + 86_400_000);
  await database.insert(schema.learnerSession).values({
    tokenHash: `${prefix}-${crypto.randomUUID()}`,
    userId,
    organizationId,
    hostname: "unconfirmed-test.example.com",
    expiresAt,
  });
  await database.insert(schema.learnerHandoff).values({
    id: `${prefix}-${crypto.randomUUID()}`,
    organizationId,
    hostname: "unconfirmed-test.example.com",
    returnPath: "/",
    nonceHash: "nonce",
    userId,
    expiresAt,
  });
  await database.insert(schema.deviceCode).values({
    id: `${prefix}-${crypto.randomUUID()}`,
    deviceCode: crypto.randomUUID(),
    userCode: crypto.randomUUID(),
    userId,
    expiresAt,
    status: "approved",
    clientId: "braivo-cli",
  });
  const clientId = `${prefix}-${crypto.randomUUID()}`;
  const scopes = ["braivo:author"];
  await database.insert(schema.oauthClient).values({
    id: clientId,
    clientId,
    userId,
    redirectUris: ["https://app.example/cb"],
  });
  await database.insert(schema.oauthConsent).values({ id: clientId, clientId, userId, scopes });
  await database.insert(schema.oauthRefreshToken).values({
    id: clientId,
    token: `refresh-${clientId}`,
    clientId,
    userId,
    scopes,
  });
  await database.insert(schema.oauthAccessToken).values({
    id: clientId,
    token: `access-${clientId}`,
    clientId,
    userId,
    refreshId: clientId,
    scopes,
  });
}
const remaining = async (userId: string) => ({
  learnerSessions: await database.$count(
    schema.learnerSession,
    eq(schema.learnerSession.userId, userId),
  ),
  handoffs: await database.$count(schema.learnerHandoff, eq(schema.learnerHandoff.userId, userId)),
  deviceCodes: await database.$count(schema.deviceCode, eq(schema.deviceCode.userId, userId)),
  connections: await database.$count(
    schema.oauthAccessToken,
    eq(schema.oauthAccessToken.userId, userId),
  ),
  refreshTokens: await database.$count(
    schema.oauthRefreshToken,
    eq(schema.oauthRefreshToken.userId, userId),
  ),
  consents: await database.$count(schema.oauthConsent, eq(schema.oauthConsent.userId, userId)),
  appleLinks: await appleLinks(userId),
});
const nothingLeft = {
  learnerSessions: 0,
  handoffs: 0,
  deviceCodes: 0,
  connections: 0,
  refreshTokens: 0,
  consents: 0,
  appleLinks: 0,
};
const at = new Date("2026-11-10T00:00:00.000Z");

/** Requires TEST_DATABASE_URL: accounts live in the real schema. */
describe.skipIf(!connectionString)("an email Sign in with Apple left unconfirmed", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, { organizationId, learnerIds: [], at });
    await registerLearnDomain({
      database,
      baseUrl,
      organizationSlug: organizationId,
      hostname: new URL(learnOrigin).hostname,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    revoked.length = 0;
    refusedRevocations.clear();
  });
  afterAll(async () => {
    await database.delete(schema.organization).where(eq(schema.organization.id, organizationId));
    const users = await database
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(inArray(schema.user.email, emails));
    const ids = users.map(({ id }) => id);
    if (ids.length > 0) {
      await database
        .delete(schema.organization)
        .where(inArray(schema.organization.personalOwnerId, ids));
      await database.delete(schema.user).where(inArray(schema.user.id, ids));
    }
  });

  test("is made by Apple's token when no account has it, and signed in to again by subject", async () => {
    await standInForProviders();
    const made = await unconfirmedAccount();
    const again = await signInWith("apple", { email: made.email, sub: made.sub });

    expect(await userOf(made.id)).toMatchObject({ emailVerified: false });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { user: { id: string } }).user.id).toBe(made.id);
    expect(await userOf(made.id)).toMatchObject({ emailVerified: false });
  });

  test("never links Apple's token to another account by that email, but offers a link by code", async () => {
    await standInForProviders();
    const email = newEmail();
    const request = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);
    const byCode = await signInWithCode(request, outbox, { email });
    const response = await signInWith("apple", { email, sub: crypto.randomUUID() });

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("APPLE_LINK_REQUIRED");
    expect(cookiesOf(response)).not.toMatch(/session_token=[^;]/);
    expect(await appleLinks(byCode.id)).toBe(0);
  });

  describe("reaches nothing an email names", () => {
    test("an invitation: not shown as its recipient, and refused acceptance", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      const inviter = await signInWithCode(
        (path, init) => api.request(`/api/auth${path}`, init),
        outbox,
        { email: newEmail("fernwood.example") },
      );
      const invitationId = `${prefix}-${crypto.randomUUID()}`;
      await database.insert(schema.invitation).values({
        id: invitationId,
        organizationId,
        email: made.email,
        role: "author",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        inviterId: inviter.id,
      });

      const page = await api.request(`/api/invitations/${invitationId}`, {
        headers: { cookie: made.cookie },
      });
      const accepted = await post(
        "/api/auth/organization/accept-invitation",
        { invitationId },
        made.cookie,
      );

      expect(await page.json()).toMatchObject({ recipient: false });
      expect(accepted.status).toBe(403);
      expect(await codeOf(accepted)).toBe(
        "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
      );
      expect(await database.$count(schema.member, eq(schema.member.userId, made.id))).toBe(0);
    });

    test("setting up a school, though its personal organization is set up", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      const offered = await api.request("/api/organization-setup", {
        headers: { cookie: made.cookie },
      });
      const school = await post(
        "/api/organization-setup",
        { name: "Fernwood", slug: `${prefix}-${crypto.randomUUID().slice(0, 8)}` },
        made.cookie,
      );
      const personal = await post("/api/organization-setup", { personal: true }, made.cookie);

      expect(await offered.json()).toMatchObject({ maySetUp: false });
      expect(school.status).toBe(403);
      expect(await codeOf(school)).toBe("EMAIL_UNCONFIRMED");
      expect(personal.status).toBe(201);
    });

    test("approving a device or granting a connection, which could outlive it changing hands", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      const confirmed = await signInWithCode(
        (path, init) => api.request(`/api/auth${path}`, init),
        outbox,
        { email: newEmail("fernwood.example") },
      );
      const grants = (cookie: string) =>
        Promise.all([
          post("/api/auth/device/approve", { userCode: "ABCD-EFGH" }, cookie),
          post("/api/auth/oauth2/consent", { accept: true }, cookie),
          post("/api/auth/oauth2/continue", { postLogin: true }, cookie),
          api.request("/api/auth/oauth2/authorize?client_id=x&response_type=code", {
            headers: { cookie },
          }),
        ]);

      for (const answer of await grants(made.cookie)) {
        expect(answer.status).toBe(403);
        expect(await codeOf(answer)).toBe("EMAIL_UNCONFIRMED");
      }
      // Refused for its own reasons, never this one, once confirmed.
      for (const answer of await grants(confirmed.cookie)) {
        const code = await answer
          .clone()
          .json()
          .then((body) => (body as { code?: string }).code)
          .catch(() => undefined);
        expect(code).not.toBe("EMAIL_UNCONFIRMED");
      }
    });

    test("every operator command that finds an account by its email", async () => {
      await standInForProviders();
      const { email } = await unconfirmedAccount();
      const refusal = `${email} is unconfirmed`;

      await expect(
        createOrganization(auth, { name: "Fernwood", slug: `${prefix}-x`, ownerEmail: email }),
      ).rejects.toThrow(refusal);
      await expect(
        addMember(auth, { slug: organizationId, email, role: "member" }),
      ).rejects.toThrow(refusal);
      await expect(
        previewOwnerPromotion({ database, slug: organizationId, email }),
      ).rejects.toThrow(refusal);
      await expect(
        setReviewerPassword(auth, { email, password: "a-reviewer-password-long" }),
      ).rejects.toThrow(refusal);
      await expect(removeReviewerPassword(auth, email)).rejects.toThrow(refusal);
      await expect(previewAccountErasure({ database, email })).rejects.toThrow(refusal);
      await expect(
        previewHistoryErasure({ database, email, organizationSlug: organizationId }),
      ).rejects.toThrow(refusal);
      await expect(
        exportLearner({ database, email, scope: "account", at: new Date() }),
      ).rejects.toThrow(refusal);
    });
  });

  describe("confirmed within its Apple session", () => {
    test("by a code sent there: nothing else changes", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      const sent = await post(
        "/api/auth/email-otp/send-verification-otp",
        { email: made.email, type: "email-verification" },
        made.cookie,
      );
      const confirmed = await post(
        "/api/auth/email-otp/verify-email",
        { email: made.email, otp: codeSentTo(outbox, made.email) },
        made.cookie,
      );

      expect(sent.status).toBe(200);
      expect(confirmed.status).toBe(200);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: true });
      expect(await appleLinks(made.id)).toBe(1);
      expect(await signedIn(made.cookie)).toBe(true);
      expect(revoked).toEqual([]);
    });

    test("only in a session of that account, while unconfirmed", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      const other = await unconfirmedAccount();
      const ask = (cookie?: string) =>
        post(
          "/api/auth/email-otp/send-verification-otp",
          { email: made.email, type: "email-verification" },
          cookie,
        );
      const redeem = (cookie?: string) =>
        post("/api/auth/email-otp/verify-email", { email: made.email, otp: "123456" }, cookie);

      for (const answer of [
        await ask(),
        await ask(other.cookie),
        await redeem(),
        await redeem(other.cookie),
      ]) {
        expect(answer.status).toBe(403);
        expect(await codeOf(answer)).toBe("EMAIL_CONFIRMATION_NOT_ALLOWED");
      }
      expect(await userOf(made.id)).toMatchObject({ emailVerified: false });
    });

    test("a sign-in code confirms nothing in place, nor does a confirmation code sign in", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      await post("/api/auth/email-otp/send-verification-otp", {
        email: made.email,
        type: "sign-in",
      });
      const signInCode = codeSentTo(outbox, made.email);
      const inPlace = await post(
        "/api/auth/email-otp/verify-email",
        { email: made.email, otp: signInCode },
        made.cookie,
      );
      await forgetMinute(made.email);
      await post(
        "/api/auth/email-otp/send-verification-otp",
        { email: made.email, type: "email-verification" },
        made.cookie,
      );
      const confirmationCode = codeSentTo(outbox, made.email);
      const asSignIn =
        confirmationCode === signInCode
          ? undefined
          : await post("/api/auth/sign-in/email-otp", { email: made.email, otp: confirmationCode });

      expect(inPlace.status).toBe(400);
      if (asSignIn) expect(asSignIn.status).toBe(400);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: false });
      expect(await appleLinks(made.id)).toBe(1);
    });
  });

  describe("first confirmed anywhere else", () => {
    test("by a code sign-in: Apple unlinked and revoked, every other way in ended", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      await otherWaysIn(made.id);
      const byCode = await signInWithCode(
        (path, init) => api.request(`/api/auth${path}`, init),
        outbox,
        { email: made.email },
      );

      expect(byCode.id).toBe(made.id);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: true });
      expect(await remaining(made.id)).toEqual(nothingLeft);
      expect(revoked).toEqual([`refresh-${made.sub}`]);
      expect(await signedIn(made.cookie)).toBe(false);
      expect(await signedIn(byCode.cookie)).toBe(true);

      // Confirmed, a later code sign-in changes nothing.
      await forgetMinute(made.email);
      const later = await signInWithCode(
        (path, init) => api.request(`/api/auth${path}`, init),
        outbox,
        { email: made.email },
      );
      expect(await signedIn(byCode.cookie)).toBe(true);
      expect(await signedIn(later.cookie)).toBe(true);
    });

    test("by a learn domain's code, and only the right one", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      await otherWaysIn(made.id);
      const learn = (path: string, body: unknown) =>
        api.request(`${learnOrigin}/api/session/${path}`, {
          method: "POST",
          headers: { ...json, origin: learnOrigin },
          body: JSON.stringify(body),
        });
      expect((await learn("code", { email: made.email })).status).toBe(204);
      const code = codeSentTo(outbox, made.email);

      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
      expect((await learn("sign-in", { email: made.email, code: wrong })).status).toBe(400);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: false });
      expect(await appleLinks(made.id)).toBe(1);
      expect(await signedIn(made.cookie)).toBe(true);
      expect(revoked).toEqual([]);

      // Proved the mailbox, if refused as no member's (access-33).
      const right = await learn("sign-in", { email: made.email, code });
      expect(await codeOf(right)).toBe("NOT_A_MEMBER");
      expect(await userOf(made.id)).toMatchObject({ emailVerified: true });
      expect(await remaining(made.id)).toEqual(nothingLeft);
      expect(revoked).toEqual([`refresh-${made.sub}`]);
      expect(await signedIn(made.cookie)).toBe(false);
    });

    test("by a learn domain's code made at once with Apple's account", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount();
      await otherWaysIn(made.id);
      // Its first lookup finds none, as if Apple made the account just after.
      const { internalAdapter } = await auth.$context;
      vi.spyOn(internalAdapter, "findUserByEmail").mockResolvedValueOnce(null);
      const { user } = await auth.api.verifiedAccount({ body: { email: made.email } });

      expect(user.id).toBe(made.id);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: true });
      expect(await remaining(made.id)).toEqual(nothingLeft);
      expect(revoked).toEqual([`refresh-${made.sub}`]);
    });

    test("by a token from the provider controlling the mailbox, which it then links", async () => {
      await standInForProviders();
      const made = await unconfirmedAccount(newEmail("gmail.com"));
      await otherWaysIn(made.id);
      const byGoogle = await signInWith("google", { email: made.email, sub: crypto.randomUUID() });

      expect(byGoogle.status).toBe(200);
      expect(((await byGoogle.json()) as { user: { id: string } }).user.id).toBe(made.id);
      expect(await userOf(made.id)).toMatchObject({ emailVerified: true });
      expect(await remaining(made.id)).toEqual(nothingLeft);
      expect(revoked).toEqual([`refresh-${made.sub}`]);
      expect(await signedIn(made.cookie)).toBe(false);
      expect(await signedIn(cookiesOf(byGoogle))).toBe(true);
      expect(
        await database.$count(
          schema.account,
          and(eq(schema.account.userId, made.id), eq(schema.account.providerId, "google")),
        ),
      ).toBe(1);
    });
  });
  describe("linked by a code to the account holding its email", () => {
    const signInByCode = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);

    /** An account a code made on `email`, and its session. */
    const codeAccount = (email: string) => signInWithCode(signInByCode, outbox, { email });

    /** Apple's sign-in refused for `email`, answering its link. */
    async function refusedForLink(
      email: string,
      sub: string,
      user?: unknown,
      refreshToken = `refresh-${sub}`,
    ) {
      const nonce = await newNonce();
      const response = await post("/api/auth/sign-in/social", {
        provider: "apple",
        idToken: {
          token: await token("apple", { email, sub, nonce: hashed(nonce) }),
          nonce,
          ...(user !== undefined && { user }),
        },
        authorizationCode: `${sub}:${refreshToken}`,
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { code: string; linkId: string; email: string };
      expect(body).toMatchObject({ code: "APPLE_LINK_REQUIRED", email });
      return body.linkId;
    }

    /** A code sign-in to `email` carrying `appleLinkId`. */
    async function signInLinking(email: string, appleLinkId: string) {
      await forgetMinute(email);
      await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
      const response = await post("/api/auth/sign-in/email-otp", {
        email,
        otp: codeSentTo(outbox, email),
        appleLinkId,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        appleLinked?: boolean;
        user: { id: string; name: string };
      };
      return { ...body, cookie: cookiesOf(response) };
    }

    const subjectsOf = async (userId: string) =>
      (
        await database
          .select({ subject: schema.account.accountId })
          .from(schema.account)
          .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "apple")))
      ).map(({ subject }) => subject);

    test("links, keeping the exchanged token and the name, and then signs in by subject", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const sub = crypto.randomUUID();
      const linkId = await refusedForLink(email, sub, { name: { firstName: "Ada", lastName: "" } });
      const linked = await signInLinking(email, linkId);

      expect(linked.appleLinked).toBe(true);
      expect(linked.user).toMatchObject({ id: owner.id, name: "Ada" });
      expect(await subjectsOf(owner.id)).toEqual([sub]);
      expect((await userOf(owner.id))?.name).toBe("Ada");
      const again = await signInWith("apple", { email, sub });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { user: { id: string } }).user.id).toBe(owner.id);

      // The link's authorization is the account's now, as exchanged.
      const [row] = await database
        .select({
          token: schema.account.refreshToken,
          clientId: schema.account.refreshTokenClientId,
        })
        .from(schema.account)
        .where(eq(schema.account.accountId, sub));
      expect(row?.token).toBeTruthy();
      expect(row?.clientId).toBe(apple.bundleIds[0]);
      expect(revoked).toEqual([]);
    });

    test("signs in without linking for a link spent, lapsed, or for another email, revoking its token", async () => {
      await standInForProviders();
      const email = newEmail();
      await codeAccount(email);
      const other = newEmail();
      await codeAccount(other);

      const forAnother = await refusedForLink(other, crypto.randomUUID());
      expect((await signInLinking(email, forAnother)).appleLinked).toBe(false);
      expect((await signInLinking(other, forAnother)).appleLinked).toBe(false);

      const sub = crypto.randomUUID();
      const lapsing = await refusedForLink(email, sub);
      await database
        .update(schema.appleLink)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.appleLink.idHash, linkHash(lapsing)));
      expect((await signInLinking(email, lapsing)).appleLinked).toBe(false);
      expect(revoked).toContain(`refresh-${sub}`);
    });

    test("a second Apple identity replaces the first, revoking it and ending its sessions", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const first = crypto.randomUUID();
      await signInLinking(email, await refusedForLink(email, first));
      const firstSession = cookiesOf(await signInWith("apple", { email, sub: first }));
      await otherWaysIn(owner.id);

      const second = crypto.randomUUID();
      const linked = await signInLinking(email, await refusedForLink(email, second));

      expect(linked.appleLinked).toBe(true);
      expect(await subjectsOf(owner.id)).toEqual([second]);
      expect(revoked).toEqual([`refresh-${first}`]);
      expect(await signedIn(firstSession)).toBe(false);
      expect(await signedIn(owner.cookie)).toBe(false);
      expect(await signedIn(linked.cookie)).toBe(true);
      expect(await remaining(owner.id)).toEqual({ ...nothingLeft, appleLinks: 1 });
    });

    test("an Apple mailbox's token linked by email replaces another identity too", async () => {
      await standInForProviders();
      const email = newEmail("icloud.com");
      const owner = await codeAccount(email);
      const first = crypto.randomUUID();
      const firstSession = cookiesOf(await signInWith("apple", { email, sub: first }));
      const second = crypto.randomUUID();
      const replacing = await signInWith("apple", { email, sub: second });

      expect(replacing.status).toBe(200);
      expect(await subjectsOf(owner.id)).toEqual([second]);
      expect(revoked).toEqual([`refresh-${first}`]);
      expect(await signedIn(firstSession)).toBe(false);
      expect(await signedIn(cookiesOf(replacing))).toBe(true);
    });

    test("bindings at once leave one Apple identity", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const options = { database, secret, apple };
      const bind = (subject: string) =>
        bindAppleIdentity(options, {
          userId: owner.id,
          subject,
          link: { refreshToken: null, refreshTokenClientId: null },
        });
      await Promise.all([bind(crypto.randomUUID()), bind(crypto.randomUUID())]);

      expect(await subjectsOf(owner.id)).toHaveLength(1);
    });

    test("a lapsed link is revoked when the next one is made, unless its identity is linked", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const lapsed = crypto.randomUUID();
      const lapse = async (linkId: string) =>
        database
          .update(schema.appleLink)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.appleLink.idHash, linkHash(linkId)));
      await lapse(await refusedForLink(email, lapsed));
      await refusedForLink(email, crypto.randomUUID());
      expect(revoked).toEqual([`refresh-${lapsed}`]);

      // Linked by another link meanwhile, a lapsed one's authorization is the account's.
      revoked.length = 0;
      const kept = crypto.randomUUID();
      const stale = await refusedForLink(email, kept);
      await signInLinking(email, await refusedForLink(email, kept));
      await lapse(stale);
      await refusedForLink(email, crypto.randomUUID());
      expect(revoked).not.toContain(`refresh-${kept}`);
      expect(await subjectsOf(owner.id)).toEqual([kept]);
    });

    test("an expired link retried by the same identity keeps the new authorization", async () => {
      await standInForProviders();
      const email = newEmail();
      await codeAccount(email);
      const sub = crypto.randomUUID();
      const first = await refusedForLink(email, sub, undefined, "refresh-first");
      await database
        .update(schema.appleLink)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.appleLink.idHash, linkHash(first)));
      const retry = await refusedForLink(email, sub, undefined, "refresh-retry");

      // Revoking either ends the identity's authorization, the retry's too.
      expect(revoked).toEqual([]);
      const [pending] = await database
        .select()
        .from(schema.appleLink)
        .where(eq(schema.appleLink.idHash, linkHash(retry)));
      expect(pending?.refreshToken).toBeTruthy();
      expect((await signInLinking(email, retry)).appleLinked).toBe(true);
      expect(revoked).toEqual([]);
    });

    describe("when linking fails partway", () => {
      /** Makes the database refuse `statement` on `table` for rows matching `when`, until undone. */
      async function refuse(table: string, event: string, when: string) {
        const name = `${prefix.replaceAll("-", "_")}_${crypto.randomUUID().slice(0, 8)}`;
        await database.execute(
          sql.raw(
            `create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`,
          ),
        );
        await database.execute(
          sql.raw(
            `create trigger ${name} before ${event} on ${table} for each row when (${when}) execute function ${name}()`,
          ),
        );
        return async () => {
          await database.execute(sql.raw(`drop trigger ${name} on ${table}`));
          await database.execute(sql.raw(`drop function ${name}()`));
        };
      }

      test("the code's sign-in stands, linking nothing, the link left pending", async () => {
        await standInForProviders();
        const email = newEmail();
        const owner = await codeAccount(email);
        const sub = crypto.randomUUID();
        const linkId = await refusedForLink(email, sub);
        const undo = await refuse("account", "insert", `new.account_id = '${sub}'`);
        const linked = await signInLinking(email, linkId).finally(undo);

        expect(linked.appleLinked).toBe(false);
        expect(await signedIn(linked.cookie)).toBe(true);
        expect(await subjectsOf(owner.id)).toEqual([]);
        expect(
          await database.$count(schema.appleLink, eq(schema.appleLink.idHash, linkHash(linkId))),
        ).toBe(1);
        expect(revoked).toEqual([]);
      });

      test("a replacement whose cleanup fails commits nothing: the old identity, and its access, kept", async () => {
        await standInForProviders();
        const email = newEmail();
        const owner = await codeAccount(email);
        const first = crypto.randomUUID();
        await signInLinking(email, await refusedForLink(email, first));
        const firstSession = cookiesOf(await signInWith("apple", { email, sub: first }));
        await otherWaysIn(owner.id);
        const second = crypto.randomUUID();
        const linkId = await refusedForLink(email, second);
        const undo = await refuse("learner_session", "delete", `old.user_id = '${owner.id}'`);
        const linked = await signInLinking(email, linkId).finally(undo);

        expect(linked.appleLinked).toBe(false);
        expect(await signedIn(linked.cookie)).toBe(true);
        expect(await subjectsOf(owner.id)).toEqual([first]);
        expect(await signedIn(firstSession)).toBe(true);
        expect(revoked).toEqual([]);
      });
    });

    test("erasure says when a waiting link's authorization was not revoked, or one of several", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const linked = crypto.randomUUID();
      await signInLinking(email, await refusedForLink(email, linked));
      const pending = crypto.randomUUID();
      await refusedForLink(email, pending);
      refusedRevocations.add(`refresh-${pending}`);

      expect(
        await revokeAppleAuthorizationsOf({ database, secret, apple }, { userId: owner.id, email }),
      ).toBe("not revoked");
      expect(revoked.toSorted()).toEqual([`refresh-${linked}`, `refresh-${pending}`].toSorted());

      // Where the secret or Apple's key is missing, a waiting link is not revoked either.
      const other = newEmail();
      await codeAccount(other);
      await refusedForLink(other, crypto.randomUUID());
      expect(await revokeAppleAuthorizationsOf({ database }, { userId: null, email: other })).toBe(
        "not revoked",
      );
      expect(await database.$count(schema.appleLink, eq(schema.appleLink.email, other))).toBe(0);
    });

    test("a token kept under a secret since rotated is not revoked, and the operator is told", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      await signInLinking(email, await refusedForLink(email, crypto.randomUUID()));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rotated = `${secret}-rotated`;

      expect(
        await revokeAppleAuthorizationsOf(
          { database, secret: rotated, apple },
          { userId: owner.id, email },
        ),
      ).toBe("not revoked");
      expect(revoked).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/unreadable under the current secret/),
      );
    });

    test("an Apple identity whose email Apple has not verified, for an email another account holds, is refused as unverified", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const nonce = await newNonce();
      const response = await post("/api/auth/sign-in/social", {
        provider: "apple",
        idToken: {
          token: await token("apple", {
            email,
            sub: crypto.randomUUID(),
            email_verified: false,
            nonce: hashed(nonce),
          }),
          nonce,
        },
      });

      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("email_not_verified");
      expect(await subjectsOf(owner.id)).toEqual([]);
      expect(await database.$count(schema.appleLink, eq(schema.appleLink.email, email))).toBe(0);
    });

    test("erasure releases the links waiting for a code to the address, with no account too", async () => {
      await standInForProviders();
      const email = newEmail();
      const sub = crypto.randomUUID();
      await codeAccount(email);
      await refusedForLink(email, sub);

      expect(
        await revokeAppleAuthorizationsOf({ database, secret, apple }, { userId: null, email }),
      ).toBe("revoked");
      expect(revoked).toEqual([`refresh-${sub}`]);
      expect(await database.$count(schema.appleLink, eq(schema.appleLink.email, email))).toBe(0);
    });

    test("erasure releases the links waiting for a code to the address", async () => {
      await standInForProviders();
      const email = newEmail();
      const owner = await codeAccount(email);
      const sub = crypto.randomUUID();
      await refusedForLink(email, sub);

      expect(
        await revokeAppleAuthorizationsOf({ database, secret, apple }, { userId: owner.id, email }),
      ).toBe("revoked");
      expect(revoked).toEqual([`refresh-${sub}`]);
    });
  });
});
