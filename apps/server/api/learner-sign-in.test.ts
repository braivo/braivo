// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Signing in on a learn domain itself, by a code it sends (`session.ts`,
// ADR 0018): good there alone, never for the account's session.

import { createHmac } from "node:crypto";

import { runMigrations } from "@braivo/db";
import { learnerSession, learnerSignInCode, organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import { addMember } from "../auth/index.ts";
import { codeSentTo } from "../auth/testing.ts";
import { checkLearnerSignInCode, spendLearnerSignInCode } from "../persistence/index.ts";
import { baseUrl, connectionString, createTestApi } from "./testing.ts";

const { database, api, auth, outbox, signUp } = createTestApi();

const run = crypto.randomUUID().slice(0, 8);
const organizationId = `learner-sign-in-${run}`;
const learnOrigin = `https://learn-${run}.example`;
const at = new Date("2026-06-01T00:00:00.000Z");

/** A fresh address each call, so no test meets another's minute between codes. */
const freshEmail = () => `learner-${crypto.randomUUID()}@example.com`;

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  api.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const sendCode = (email: string, headers?: Record<string, string>) =>
  post(`${learnOrigin}/api/session/code`, { email }, headers);
const signIn = (email: string, code: string, headers?: Record<string, string>) =>
  post(`${learnOrigin}/api/session/sign-in`, { email, code }, headers);

/** The learner session's cookie as a browser sends it back. */
const learnerCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((set) => set.startsWith("__Host-braivo-learner="))
    ?.split(";", 1)[0];

/** A wrong code for `code`: the next one along, still six digits. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe.skipIf(!connectionString)("signing in on a learn domain by code", () => {
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

  test("signs a member in there, naming the domain in the mail, and the code once only", async () => {
    const member = await signUp();
    await addMember(auth, { slug: organizationId, email: member.email, role: "member" });

    const sent = await sendCode(member.email, { origin: learnOrigin, "accept-language": "pl" });
    expect(sent.status).toBe(204);
    const mail = outbox.sent.findLast((mail) => mail.to === member.email)!;
    expect(mail.text).toContain(`na stronie ${new URL(learnOrigin).hostname}`);
    const code = codeSentTo(outbox, member.email);

    const signedIn = await signIn(member.email, code, { origin: learnOrigin });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ user: { id: member.id, name: member.name } });
    const cookie = learnerCookie(signedIn)!;
    expect(cookie).toBeDefined();
    const session = await api.request(`${learnOrigin}/api/session`, { headers: { cookie } });
    expect(await session.json()).toEqual({ user: { id: member.id, name: member.name } });

    // Spent.
    const again = await signIn(member.email, code);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "OTP_EXPIRED" });
  });

  test("keeps a learn domain's code and the installation's apart", async () => {
    // An address no one has signed in with, so neither minute has begun.
    const email = freshEmail();

    // A learn domain's code opens no account session on the installation's host.
    await sendCode(email);
    const learnCode = codeSentTo(outbox, email);
    const global = await post(`${baseUrl}/api/auth/sign-in/email-otp`, { email, otp: learnCode });
    expect(global.status).toBe(400);
    expect(global.headers.getSetCookie()).toEqual([]);

    // Nor does the installation's code open a learner session; and its minute
    // is its own, so asking there was not refused for the domain's.
    const asked = await post(`${baseUrl}/api/auth/email-otp/send-verification-otp`, {
      email,
      type: "sign-in",
    });
    expect(asked.status).toBe(200);
    const accountCode = codeSentTo(outbox, email);
    expect(outbox.sent.at(-1)!.text).toContain(`at ${new URL(baseUrl).host}`);
    const crossed = await signIn(email, accountCode);
    expect(await crossed.json()).toMatchObject({ code: "INVALID_OTP" });
    // The domain's own is still right: refused only as no member's.
    expect(await (await signIn(email, learnCode)).json()).toMatchObject({ code: "NOT_A_MEMBER" });
  });

  test("makes an account for a new address, refused as no member until added, then signs in with the same code", async () => {
    const email = freshEmail();
    await sendCode(email);
    const code = codeSentTo(outbox, email);

    const refused = await signIn(email, code);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "NOT_A_MEMBER" });
    expect(learnerCookie(refused)).toBeUndefined();

    // The operator adds members by an account's email, which now exists.
    await addMember(auth, { slug: organizationId, email, role: "member" });
    const signedIn = await signIn(email, code);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ user: { name: "" } });
    const cookie = learnerCookie(signedIn)!;

    // Named once, by the sign-in's last step; never renamed from here.
    const name = (value: unknown, headers: Record<string, string> = { cookie }) =>
      post(`${learnOrigin}/api/session/name`, { name: value }, headers);
    expect((await name("Ada", {})).status).toBe(401);
    expect((await name("  ")).status).toBe(400);
    expect((await name("x".repeat(201))).status).toBe(400);
    expect((await name("  Ada  ")).status).toBe(204);
    const session = await api.request(`${learnOrigin}/api/session`, { headers: { cookie } });
    expect(await session.json()).toMatchObject({ user: { name: "Ada" } });
    const renamed = await name("Eve");
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toMatchObject({ code: "ALREADY_NAMED" });
  });

  test("signs a member in once with a right code sent twice at once", async () => {
    const member = await signUp();
    await addMember(auth, { slug: organizationId, email: member.email, role: "member" });
    await sendCode(member.email);
    const code = codeSentTo(outbox, member.email);

    const answers = await Promise.all([signIn(member.email, code), signIn(member.email, code)]);

    expect(answers.map(({ status }) => status).toSorted((a, b) => a - b)).toEqual([200, 400]);
    const sessions = await database
      .select()
      .from(learnerSession)
      .where(eq(learnerSession.userId, member.id));
    expect(sessions).toHaveLength(1);
  });

  test("makes one account for an address however many ask for it at once", async () => {
    const email = freshEmail();

    const made = await Promise.all(
      Array.from({ length: 25 }, async () => auth.api.verifiedAccount({ body: { email } })),
    );

    expect(new Set(made.map(({ user }) => user.id)).size).toBe(1);
  });

  test("counts wrong guesses, five at most, after which even the right code is refused", async () => {
    const email = freshEmail();
    await sendCode(email);
    const code = codeSentTo(outbox, email);

    // Guessed at once, each counts.
    const guesses = await Promise.all(
      Array.from({ length: 4 }, async () => signIn(email, wrong(code))),
    );
    for (const guess of guesses) {
      expect(guess.status).toBe(400);
      expect(await guess.json()).toMatchObject({ code: "INVALID_OTP" });
    }
    const fifth = await signIn(email, wrong(code));
    expect(fifth.status).toBe(403);
    expect(await fifth.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    const right = await signIn(email, code);
    expect(right.status).toBe(403);
    expect(await right.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  });

  test("stores a code keyed by the installation's secret, never as a plain hash", async () => {
    const email = freshEmail();
    await sendCode(email);
    const code = codeSentTo(outbox, email);

    const [row] = await database
      .select({ codeHash: learnerSignInCode.codeHash })
      .from(learnerSignInCode)
      .where(eq(learnerSignInCode.email, email));
    // What only the installation's secret reproduces, bound to the domain
    // and the address, so a leaked row cannot be checked against a million
    // guesses, nor reused for another domain or address.
    const keyed = (key: string, hostname: string) =>
      createHmac("sha256", key)
        .update(`learner-sign-in\0${hostname}\0${email}\0${code}`)
        .digest("base64url");
    const { secret } = await auth.$context;
    const hostname = new URL(learnOrigin).hostname;
    expect(row?.codeHash).toBe(keyed(secret, hostname));
    expect(row?.codeHash).not.toBe(keyed("another secret", hostname));
    expect(row?.codeHash).not.toBe(keyed(secret, "elsewhere.example"));
  });

  test("refuses a code not six digits as malformed, counting no guess", async () => {
    const email = freshEmail();
    await sendCode(email);

    for (const code of ["1", "12345", "1234567", "12345a"]) {
      expect((await signIn(email, code)).status).toBe(400);
    }
    const [row] = await database
      .select({ attempts: learnerSignInCode.attempts })
      .from(learnerSignInCode)
      .where(eq(learnerSignInCode.email, email));
    expect(row?.attempts).toBe(0);
  });

  test("spends nothing a right code checked, then guessed out or expired, before its session", async () => {
    const member = await signUp();
    await addMember(auth, { slug: organizationId, email: member.email, role: "member" });
    const hostname = new URL(learnOrigin).hostname;
    const spend = async (codeHash: string) =>
      spendLearnerSignInCode(database, {
        hostname,
        email: member.email,
        organizationId,
        codeHash,
        attempts: 5,
        userId: member.id,
        at: new Date(),
        session: { tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      });
    const storedHash = async () =>
      (
        await database
          .select({ codeHash: learnerSignInCode.codeHash })
          .from(learnerSignInCode)
          .where(
            and(
              eq(learnerSignInCode.hostname, hostname),
              eq(learnerSignInCode.email, member.email),
            ),
          )
      )[0]!.codeHash!;
    const check = (codeHash: string) =>
      checkLearnerSignInCode(database, {
        hostname,
        email: member.email,
        codeHash,
        attempts: 5,
        at: new Date(),
      });

    // Guessed out between the right check and the spend.
    await sendCode(member.email);
    const right = await storedHash();
    expect(await check(right)).toMatchObject({ kind: "right" });
    for (let guess = 0; guess < 5; guess++) await check("wrong");
    expect(await spend(right)).toBe(false);

    // Expired between them: a new code, the minute waited out.
    await database
      .update(learnerSignInCode)
      .set({ resendAt: new Date(0) })
      .where(eq(learnerSignInCode.email, member.email));
    await sendCode(member.email);
    const fresh = await storedHash();
    expect(await check(fresh)).toMatchObject({ kind: "right" });
    const expiresAt = (
      await database
        .update(learnerSignInCode)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(learnerSignInCode.email, member.email))
        .returning({ expiresAt: learnerSignInCode.expiresAt })
    )[0]!.expiresAt;
    expect(await spend(fresh)).toBe(false);

    const sessions = await database
      .select()
      .from(learnerSession)
      .where(eq(learnerSession.userId, member.id));
    expect(sessions).toEqual([]);
    // Spendable again once unexpired: only the expiry refused it.
    await database
      .update(learnerSignInCode)
      .set({ expiresAt: new Date(expiresAt.getTime() + 60 * 60_000) })
      .where(eq(learnerSignInCode.email, member.email));
    expect(await spend(fresh)).toBe(true);
  });

  test("spends nothing a code that expires while the spend waits for its row", async () => {
    const member = await signUp();
    await addMember(auth, { slug: organizationId, email: member.email, role: "member" });
    const hostname = new URL(learnOrigin).hostname;
    await sendCode(member.email);
    const row = and(
      eq(learnerSignInCode.hostname, hostname),
      eq(learnerSignInCode.email, member.email),
    );
    const [{ codeHash } = { codeHash: null }] = await database
      .select({ codeHash: learnerSignInCode.codeHash })
      .from(learnerSignInCode)
      .where(row);
    // Good for a moment more, as the spend starts.
    const [{ expiresAt } = { expiresAt: new Date(0) }] = await database
      .update(learnerSignInCode)
      .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
      .where(row)
      .returning({ expiresAt: learnerSignInCode.expiresAt });

    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holding = database.transaction(async (transaction) => {
      await transaction.select().from(learnerSignInCode).where(row).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const spending = spendLearnerSignInCode(database, {
      hostname,
      email: member.email,
      organizationId,
      codeHash: codeHash!,
      attempts: 5,
      userId: member.id,
      at: new Date(),
      session: { tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    });
    // Released whatever happens: a lock left held would stall every later test.
    try {
      // Waiting for the row while the code is still good: what this proves.
      await vi.waitFor(
        async () => {
          const { rows } = await database.execute<{ waiting: number }>(
            sql`select count(*)::int as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and query like '%learner_sign_in_code%'`,
          );
          expect(rows[0]?.waiting).toBeGreaterThan(0);
        },
        { interval: 20 },
      );
      expect(Date.now()).toBeLessThan(expiresAt.getTime());
      // Expired while it waits.
      await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now() + 100));
    } finally {
      release.resolve();
      await holding;
    }

    expect(await spending).toBe(false);
  });

  test("forgets expired codes as new ones are sent", async () => {
    const stale = freshEmail();
    await sendCode(stale);
    await database
      .update(learnerSignInCode)
      .set({ expiresAt: new Date(0), resendAt: new Date(0) })
      .where(eq(learnerSignInCode.email, stale));

    await sendCode(freshEmail());

    expect(
      await database.select().from(learnerSignInCode).where(eq(learnerSignInCode.email, stale)),
    ).toEqual([]);
  });

  test("sends an address one code a minute per domain, saying so", async () => {
    const email = freshEmail();
    expect((await sendCode(email)).status).toBe(204);

    const again = await sendCode(email);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ code: "SIGN_IN_CODE_COOLDOWN" });
  });

  test("signs in nowhere once the domain serves another organization", async () => {
    const hostname = `moved-${run}.example`;
    const [first, second] = [`moved-a-${run}`, `moved-b-${run}`];
    const member = await signUp();
    for (const organization of [first, second]) {
      await testing.seedOrganization(database, {
        organizationId: organization,
        learnerIds: [],
        at,
      });
      await addMember(auth, { slug: organization, email: member.email, role: "member" });
    }
    await registerLearnDomain({ database, baseUrl, organizationSlug: first, hostname });
    await post(`https://${hostname}/api/session/code`, { email: member.email });
    const code = codeSentTo(outbox, member.email);

    // The domain moves to another organization, of which the member is one too.
    await database.delete(organizationDomain).where(eq(organizationDomain.hostname, hostname));
    await registerLearnDomain({ database, baseUrl, organizationSlug: second, hostname });
    const signedIn = await post(`https://${hostname}/api/session/sign-in`, {
      email: member.email,
      code,
    });
    expect(signedIn.status).toBe(400);
    expect(learnerCookie(signedIn)).toBeUndefined();
  });

  test("signs in on each of an organization's domains, its custom one named, its subdomain still serving", async () => {
    const slug = `fallback-${run}`;
    const [subdomain, custom] = [`${slug}.braivo.example`, `learn.${slug}.example`];
    const owner = await signUp();
    await testing.seedOrganization(database, {
      organizationId: slug,
      learnerIds: [],
      adminIds: [owner.id],
      at,
    });
    // Its subdomain at setup, then its own domain.
    await registerLearnDomain({ database, baseUrl, organizationSlug: slug, hostname: subdomain });
    await registerLearnDomain({ database, baseUrl, organizationSlug: slug, hostname: custom });
    const listed = await api.request(`${baseUrl}/api/organizations`, {
      headers: { cookie: owner.cookie },
    });
    expect(await listed.json()).toMatchObject({
      organizations: [expect.objectContaining({ slug, learnDomain: custom })],
    });

    // The custom domain not working, the subdomain still signs a member in.
    const fallback = `https://${subdomain}`;
    await post(`${fallback}/api/session/code`, { email: owner.email });
    const signedIn = await post(`${fallback}/api/session/sign-in`, {
      email: owner.email,
      code: codeSentTo(outbox, owner.email),
    });
    expect(signedIn.status).toBe(200);
    const cookie = learnerCookie(signedIn)!;
    const on = async (hostname: string) =>
      (await api.request(`https://${hostname}/api/session`, { headers: { cookie } })).status;
    expect(await on(subdomain)).toBe(200);
    // Each domain's session is its own.
    expect(await on(custom)).toBe(401);
  });

  test("answers a learn domain alone, from itself, and a client a limited number of times", async () => {
    const email = freshEmail();
    expect((await post(`${baseUrl}/api/session/code`, { email })).status).toBe(404);
    expect((await post(`${baseUrl}/api/session/sign-in`, { email, code: "1" })).status).toBe(404);
    expect((await post("https://nobody.example/api/session/code", { email })).status).toBe(404);
    expect((await sendCode(email, { origin: "https://evil.example" })).status).toBe(403);
    expect((await signIn(email, "123456", { origin: "https://evil.example" })).status).toBe(403);
    expect((await sendCode("not an email")).status).toBe(400);
    // The account it makes is made server-side alone.
    expect((await post(`${baseUrl}/api/auth/braivo/verified-account`, { email })).status).toBe(404);

    const client = { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` };
    const answers = await Promise.all(
      Array.from({ length: 121 }, async () => post(`${learnOrigin}/api/session/code`, {}, client)),
    );
    const statuses = answers.map((answer) => answer.status);
    expect(statuses.filter((status) => status === 400)).toHaveLength(120);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    // Addresses in one IPv6 /64 are one client, as to Better Auth's limiter.
    const subnet = `2001:db8:${Math.floor(Math.random() * 65_535).toString(16)}::`;
    const sharing = await Promise.all(
      Array.from({ length: 121 }, async (_, index) =>
        post(`${learnOrigin}/api/session/code`, {}, { "x-forwarded-for": `${subnet}${index + 1}` }),
      ),
    );
    expect(sharing.filter((answer) => answer.status === 429)).toHaveLength(1);
    // Another client is admitted meanwhile.
    expect(
      (await post(`${learnOrigin}/api/session/code`, {}, { "x-forwarded-for": "198.51.100.1" }))
        .status,
    ).toBe(400);
  });
});

describe.skipIf(!connectionString)("a learn domain's code that could not be sent", () => {
  const failing = createTestApi({
    sendMail: async () => {
      throw new Error("SMTP refused");
    },
  });

  test("says so, and the address still waits its minute", async () => {
    const hostname = `unsent-${run}.example`;
    const organization = `learner-sign-in-unsent-${run}`;
    await testing.seedOrganization(failing.database, {
      organizationId: organization,
      learnerIds: [],
      at,
    });
    await registerLearnDomain({
      database: failing.database,
      baseUrl,
      organizationSlug: organization,
      hostname,
    });
    const email = freshEmail();
    const send = () =>
      failing.api.request(`https://${hostname}/api/session/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

    const refused = await send();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "SIGN_IN_CODE_SEND_FAILED" });
    expect((await send()).status).toBe(429);
  });
});
