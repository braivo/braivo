// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { createApi } from "./app.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const outbox = createOutbox();
const google = { clientId: "google-test-client", clientSecret: "google-test-secret" };

function apiWith(options: { google?: typeof google }) {
  const auth = createAuth({
    database,
    secret: "google-test-secret-that-is-long-enough",
    baseURL: baseUrl,
    sendMail: outbox.sendMail,
    ...options,
  });
  return createApi({ auth, database, baseUrl });
}

const api = apiWith({ google });

/** Fresh each run, so a rerun never meets a leftover account or code limit. */
const emails: string[] = [];
function newEmail(domain = "example.com"): string {
  const email = `google-test-${crypto.randomUUID()}@${domain}`;
  emails.push(email);
  return email;
}

/**
 * What Google's token endpoint answers: an ID token, unsigned, as the callback
 * only decodes it. `hd` is required, `undefined` for a consumer account, so
 * each test states the kind of account, which decides whether Google may sign
 * in at all (access-30). `sub` is Google's own ID, apart from the email.
 */
type Profile = {
  email: string;
  email_verified: boolean;
  hd: unknown;
  name?: string;
  sub?: string;
};

/** A Workspace account's `hd`, for tests about something else. */
const WORKSPACE = "example.com";

const realFetch = globalThis.fetch;
/** Stands in for Google's token endpoint, which the callback calls; nothing else is touched. */
function googleAnswers(profile: Profile) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({ sub: crypto.randomUUID(), name: "Grace Hopper", ...profile }),
    "unsigned",
  ].join(".");
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input instanceof Request ? input.url : input) === "https://oauth2.googleapis.com/token"
      ? Promise.resolve(
          Response.json({ access_token: "access", refresh_token: "refresh", id_token: idToken }),
        )
      : realFetch(input, init),
  );
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((set) => set.split(";", 1)[0])
    .join("; ");

function startGoogle(
  headers: Record<string, string> = { origin: baseUrl },
  body: Record<string, unknown> = {},
) {
  return api.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "/courses",
      errorCallbackURL: "/login",
      ...body,
    }),
  });
}

/** The whole round trip, Google's consent standing in as `profile`: where it lands, and the cookies set. */
async function continueWithGoogle(profile: Profile) {
  const started = await startGoogle();
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  googleAnswers(profile);
  const state = new URL(url).searchParams.get("state") ?? "";
  const back = await api.request(`/api/auth/callback/google?code=granted&state=${state}`, {
    headers: { cookie: cookiesOf(started) },
  });
  expect(back.status).toBe(302);
  return { location: back.headers.get("location"), cookie: cookiesOf(back) };
}

const usersNamed = (email: string) =>
  database.select().from(authTables.user).where(eq(authTables.user.email, email));

const errorOf = (landed: { location: string | null }) =>
  new URL(landed.location ?? "", baseUrl).searchParams.get("error");

const signInByCode = (email: string) =>
  signInWithCode((path, init) => api.request(`/api/auth${path}`, init), outbox, {
    email,
    name: "Ada",
  });

const googleAccountsOf = (userId: string) =>
  database
    .select()
    .from(authTables.account)
    .where(and(eq(authTables.account.userId, userId), eq(authTables.account.providerId, "google")));

/** Requires TEST_DATABASE_URL: accounts are made and found in the real schema. */
describe.skipIf(!connectionString)("signing in with Google", () => {
  beforeAll(() => runMigrations(connectionString ?? ""));
  afterEach(() => void vi.restoreAllMocks());
  afterAll(async () => {
    if (emails.length > 0) {
      await database.delete(authTables.user).where(inArray(authTables.user.email, emails));
    }
  });

  test("is offered only by an installation with Google's client", async () => {
    const offered = await api.request("/api/sign-in-settings");
    const notOffered = await apiWith({}).request("/api/sign-in-settings");

    expect(await offered.json()).toMatchObject({ google: true });
    expect(await notOffered.json()).toMatchObject({ google: false });
  });

  test("sends the person to Google to choose an account, back to the installation", async () => {
    const started = await startGoogle();
    const { url } = (await started.json()) as { url: string };
    const asked = new URL(url);

    expect(asked.origin).toBe("https://accounts.google.com");
    expect(asked.searchParams.get("client_id")).toBe(google.clientId);
    expect(asked.searchParams.get("redirect_uri")).toBe(`${baseUrl}/api/auth/callback/google`);
    expect(asked.searchParams.get("prompt")).toBe("select_account");
  });

  test("refuses a start from another site or as a form", async () => {
    const foreign = await startGoogle({ origin: "https://evil.example" });
    const form = await startGoogle({ "content-type": "application/x-www-form-urlencoded" });

    expect([foreign.status, form.status]).toEqual([403, 403]);
  });

  test("returns only to the installation's own pages", async () => {
    const away = await Promise.all([
      startGoogle(undefined, { callbackURL: "https://evil.example/" }),
      startGoogle(undefined, { errorCallbackURL: "https://evil.example/" }),
    ]);

    expect(away.map((answer) => answer.status)).toEqual([403, 403]);
  });

  test("takes an ID token only with a nonce (native-sign-in.test.ts), and links nothing by hand", async () => {
    const idToken = await startGoogle(undefined, { idToken: { token: "a.b.c" } });
    const linking = await api.request("/api/auth/link-social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ provider: "google" }),
    });

    expect(idToken.status).toBe(400);
    expect(((await idToken.json()) as { code: string }).code).toBe("NONCE_REQUIRED");
    expect(linking.status).toBe(404);
  });

  test("comes back to /login with an error when it cannot tell where the sign-in began", async () => {
    // A state Better Auth no longer holds: expired, or already used.
    const back = await api.request("/api/auth/callback/google?code=granted&state=gone");

    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toMatch(/^\/login\?error=/);
  });

  test("makes a verified, named account for a Google-verified email, and signs it in", async () => {
    const email = newEmail();
    const landed = await continueWithGoogle({ email, email_verified: true, hd: WORKSPACE });

    expect(landed.location).toBe("/courses");
    const session = await api.request("/api/session", { headers: { cookie: landed.cookie } });
    const [user] = await usersNamed(email);
    expect(await session.json()).toEqual({ user: { id: user?.id, name: "Grace Hopper" } });
    expect(user?.emailVerified).toBe(true);
    // Encrypted, since nothing uses it: a database leak yields no live token.
    const [kept] = await database
      .select()
      .from(authTables.account)
      .where(eq(authTables.account.userId, user?.id ?? ""));
    expect(kept?.providerId).toBe("google");
    expect(kept?.accessToken).toBeTruthy();
    expect(kept?.accessToken).not.toBe("access");
    expect(kept?.refreshToken).toBeTruthy();
    expect(kept?.refreshToken).not.toBe("refresh");
  });

  test("signs in to the account an emailed code made, never making another", async () => {
    const email = newEmail();
    const { id } = await signInWithCode(
      (path, init) => api.request(`/api/auth${path}`, init),
      outbox,
      { email, name: "Ada" },
    );

    const landed = await continueWithGoogle({
      email,
      email_verified: true,
      hd: WORKSPACE,
      name: "Ada L.",
    });

    const session = await api.request("/api/session", { headers: { cookie: landed.cookie } });
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(id);
    expect(await usersNamed(email)).toHaveLength(1);
  });

  test("refuses an email Google has not verified, to make an account or reach one", async () => {
    const newcomer = newEmail();
    const existing = newEmail();
    await signInWithCode((path, init) => api.request(`/api/auth${path}`, init), outbox, {
      email: existing,
      name: "Ada",
    });

    // Better Auth refuses linking an unverified email itself, first.
    const refusals = { [newcomer]: "email_not_verified", [existing]: "account_not_linked" };
    for (const [email, error] of Object.entries(refusals)) {
      const landed = await continueWithGoogle({ email, email_verified: false, hd: WORKSPACE });
      expect(new URL(landed.location ?? "", baseUrl).searchParams.get("error")).toBe(error);
      expect(landed.cookie).not.toContain("session_token");
    }
    expect(await usersNamed(newcomer)).toEqual([]);
  });

  test("refuses a Google account whose email changed since it made the account", async () => {
    const before = newEmail();
    const after = newEmail();
    const sub = crypto.randomUUID();
    await continueWithGoogle({ email: before, email_verified: true, hd: WORKSPACE, sub });

    const landed = await continueWithGoogle({
      email: after,
      email_verified: true,
      hd: WORKSPACE,
      sub,
    });

    expect(new URL(landed.location ?? "", baseUrl).searchParams.get("error")).toBe("email_changed");
    expect(landed.cookie).not.toContain("session_token");
    expect(await usersNamed(before)).toHaveLength(1);
    expect(await usersNamed(after)).toEqual([]);
  });

  test("signs in again while Google calls the email verified, and no longer once it does not", async () => {
    const email = newEmail();
    const sub = crypto.randomUUID();
    await continueWithGoogle({ email, email_verified: true, hd: WORKSPACE, sub });

    const again = await continueWithGoogle({ email, email_verified: true, hd: WORKSPACE, sub });
    const unverified = await continueWithGoogle({
      email,
      email_verified: false,
      hd: WORKSPACE,
      sub,
    });

    expect(again.location).toBe("/courses");
    expect(again.cookie).toContain("session_token");
    expect(await usersNamed(email)).toHaveLength(1);
    expect(new URL(unverified.location ?? "", baseUrl).searchParams.get("error")).toBe(
      "email_not_verified",
    );
  });

  describe("only where Google is authoritative for the email", () => {
    // A consumer Google account can be registered on any address, and its
    // verification can outlive the mailbox's ownership: a school's former
    // pupil would reach the next one's account. Google is authoritative only
    // for Gmail's own addresses and Workspace accounts (`hd`).
    const notAuthoritative = (email: string, sub = crypto.randomUUID()) => ({
      email,
      email_verified: true,
      sub,
      hd: undefined,
    });

    test("refuses making an account, saying so, and makes none", async () => {
      const pupil = newEmail("school.example");

      const landed = await continueWithGoogle(notAuthoritative(pupil));

      expect(errorOf(landed)).toBe("email_not_authoritative");
      expect(landed.cookie).not.toContain("session_token");
      expect(await usersNamed(pupil)).toEqual([]);
    });

    test("refuses linking to the account a code made, and signs nothing in", async () => {
      const pupil = newEmail("school.example");
      const { id } = await signInByCode(pupil);

      const landed = await continueWithGoogle(notAuthoritative(pupil));

      expect(errorOf(landed)).toBe("email_not_authoritative");
      expect(landed.cookie).not.toContain("session_token");
      expect(await googleAccountsOf(id)).toEqual([]);
    });

    test("refuses signing in through a Google account already linked", async () => {
      const pupil = newEmail("school.example");
      const sub = crypto.randomUUID();
      const { id } = await signInByCode(pupil);
      // Inserted, as linking now refuses it: an installation may hold one.
      await database.insert(authTables.account).values({
        id: crypto.randomUUID(),
        userId: id,
        providerId: "google",
        accountId: sub,
        createdAt: new Date(),
      });

      const landed = await continueWithGoogle(notAuthoritative(pupil, sub));

      expect(errorOf(landed)).toBe("email_not_authoritative");
      expect(landed.cookie).not.toContain("session_token");
    });

    test("refuses an hd claim that is empty or not a string", async () => {
      for (const hd of ["", 42, null]) {
        const email = newEmail("school.example");
        const landed = await continueWithGoogle({ email, email_verified: true, hd });
        expect(errorOf(landed)).toBe("email_not_authoritative");
        expect(await usersNamed(email)).toEqual([]);
      }
    });

    test("refuses an address that only looks like Gmail's", async () => {
      for (const domain of ["gmail.com.attacker.example", "notgmail.com"]) {
        const email = newEmail(domain);
        const landed = await continueWithGoogle(notAuthoritative(email));
        expect(errorOf(landed)).toBe("email_not_authoritative");
        expect(landed.cookie).not.toContain("session_token");
        expect(await usersNamed(email)).toEqual([]);
      }
    });

    test("accepts Gmail: makes, links, and signs in", async () => {
      const made = newEmail("gmail.com");
      const coded = newEmail("gmail.com");
      const { id } = await signInByCode(coded);
      const sub = crypto.randomUUID();

      const created = await continueWithGoogle({
        email: made,
        email_verified: true,
        hd: undefined,
      });
      const linked = await continueWithGoogle({
        email: coded,
        email_verified: true,
        sub,
        hd: undefined,
      });
      const again = await continueWithGoogle({
        email: coded,
        email_verified: true,
        sub,
        hd: undefined,
      });

      for (const landed of [created, linked, again]) {
        expect(landed.location).toBe("/courses");
        expect(landed.cookie).toContain("session_token");
      }
      expect(await usersNamed(made)).toHaveLength(1);
      expect(await googleAccountsOf(id)).toHaveLength(1);
    });

    test("accepts a Workspace account, its hd another of its domains included", async () => {
      const pupil = newEmail("school.example");
      const { id } = await signInByCode(pupil);
      const sub = crypto.randomUUID();
      const workspace = { email: pupil, email_verified: true, sub, hd: "district.example" };

      const linked = await continueWithGoogle(workspace);
      const again = await continueWithGoogle(workspace);
      // Asked afresh at every sign-in, not only when linking: the same Google
      // account answering without `hd` no longer signs in.
      const left = await continueWithGoogle({ ...workspace, hd: undefined });

      for (const landed of [linked, again]) {
        expect(landed.location).toBe("/courses");
        expect(landed.cookie).toContain("session_token");
      }
      expect(errorOf(left)).toBe("email_not_authoritative");
      expect(left.cookie).not.toContain("session_token");
      expect(await googleAccountsOf(id)).toHaveLength(1);
    });
  });
});
