// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createObjectives } from "../persistence/index.ts";
import { createAuth } from "./auth.ts";
import { addMember, createOrganization } from "./organization.ts";
import { codeSentTo, createOutbox, signInWithCode } from "./testing.ts";

const connectionString = process.env.TEST_DATABASE_URL;

/** Signed in once per run: an address gets one code a minute. */
const owner = { email: "auth-test-owner@example.com", name: "Owner" };
/** Signed in by the test that checks making an account. */
const newcomer = "auth-test-newcomer@example.com";
/** Signed in by the test that tries to answer invitations. */
const invitee = { email: "auth-test-invitee@example.com", name: "Invitee" };
/** Signed in by the test that adds members, as the operator does. */
const learner = { email: "auth-test-learner@example.com", name: "Learner" };
/** Asked for codes by the tests that check their limits. */
const asking = [
  "auth-test-asks@example.com",
  "auth-test-asks-at-once@example.com",
  "auth-test-asks-late@example.com",
  "auth-test-unsent@example.com",
  "auth-test-unsent-directly@example.com",
  "auth-test-sent-beside@example.com",
];
/** Asked for a code each, under the `Accept-Language` it names. */
const askingIn = {
  "pl-PL,pl;q=0.9": "auth-test-asks-pl@example.com",
  "en;q=0.5, pl;q=0.8": "auth-test-asks-weighted@example.com",
  de: "auth-test-asks-de@example.com",
  "": "auth-test-asks-unsaid@example.com",
};
/** Asked for a code by the server itself, with no request. */
const askingDirectly = "auth-test-asks-directly@example.com";
/** Every organization this suite creates or tries to, by slug. */
const slugs = {
  school: "auth-test-school",
  foreignOrigin: "auth-test-foreign-origin",
  ownsContent: "auth-test-owns-content",
  halfDeleted: "auth-test-half-deleted",
  ownsNothing: "auth-test-owns-nothing",
  renamed: "auth-test-renamed",
  renamedAgain: "auth-test-renamed-again",
  hasDomain: "auth-test-has-domain",
  noOwner: "auth-test-no-owner",
  selfServe: "auth-test-self-serve",
  taken: "auth-test-taken",
  invites: "auth-test-invites",
  roster: "auth-test-roster",
  enrolls: "auth-test-enrolls",
  adminAdded: "auth-test-admin-added",
  // Listed so a regression that lets them through is cleaned up after itself.
  reserved: "login",
  malformed: "Auth-Test-Capitals",
};

const database = testing.sharedDatabase(connectionString ?? "");
const outbox = createOutbox();
const auth = createAuth({
  database,
  secret: "test-secret-that-is-long-enough-32",
  baseURL: "http://localhost:3000",
  sendMail: outbox.sendMail,
});

/** Drives the same `Request` → `Response` surface an HTTP entry point mounts. */
function call(path: string, init?: RequestInit) {
  return auth.handler(new Request(`http://localhost:3000/api/auth${path}`, init));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, {
    method: "POST",
    // Better Auth checks the origin on its organization endpoints.
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

/** The owner's session, from `beforeAll`. */
let ownerCookie!: string;
const signIn = (account: { email: string; name: string }) =>
  signInWithCode(call, outbox, account).then(({ cookie }) => cookie);

async function createOwned(slug: string): Promise<string> {
  return (await createOrganization(auth, { name: slug, slug, ownerEmail: owner.email })).id;
}

const membersOf = (id: string) =>
  database.select().from(authTables.member).where(eq(authTables.member.organizationId, id));

/**
 * Removes this suite's rows and nothing else: its organizations, after the
 * content that would block deleting them, then its users, whose sessions and
 * memberships cascade, and its addresses' codes, so a rerun within the minute
 * gets new ones.
 */
async function clearFixtures(): Promise<void> {
  const { organization, user, verification } = authTables;
  const ours = inArray(organization.slug, Object.values(slugs));
  const leftovers = await database.select({ id: organization.id }).from(organization).where(ours);
  for (const { id } of leftovers) await testing.clearLearningData(database, id);
  await database.delete(organization).where(ours);
  const emails = [
    owner.email,
    newcomer,
    invitee.email,
    learner.email,
    ...asking,
    ...Object.values(askingIn),
    askingDirectly,
  ];
  await database.delete(user).where(inArray(user.email, emails));
  await database.delete(verification).where(
    inArray(
      verification.identifier,
      emails.flatMap((email) => [`sign-in-otp-${email}`, `sign-in-code-sent:${email}`]),
    ),
  );
}

const sendCode = (email: string, type = "sign-in") =>
  post("/email-otp/send-verification-otp", { email, type });

/** Requires TEST_DATABASE_URL: the point is that Better Auth runs on the real schema. */
describe.skipIf(!connectionString)("Better Auth against PostgreSQL", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await clearFixtures();
    ownerCookie = await signIn(owner);
  });

  afterAll(clearFixtures);

  test("an emailed code makes a verified, named account and signs it in, once", async () => {
    expect((await sendCode(newcomer)).status).toBe(200);
    const [mail] = outbox.sent.filter((sent) => sent.to === newcomer);
    const code = codeSentTo(outbox, newcomer);
    expect(mail?.subject).toBe(`${code} is your sign-in code`);
    // Hashed: whoever reads the table holds no live code.
    const { verification } = authTables;
    const [stored] = await database
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, `sign-in-otp-${newcomer}`));
    expect(stored?.value).not.toContain(code);

    const signedIn = await post("/sign-in/email-otp", {
      email: newcomer,
      otp: code,
      name: "Newcomer",
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("better-auth.session_token");
    const session = await call("/get-session", { headers: { cookie } });
    expect(await session.json()).toMatchObject({
      user: { email: newcomer, name: "Newcomer", emailVerified: true },
    });

    const again = await post("/sign-in/email-otp", { email: newcomer, otp: code });
    expect(again.status).toBe(400);
  });

  test("writes the code's mail in the language its request asks for (localization-6)", async () => {
    for (const [acceptLanguage, email] of Object.entries(askingIn)) {
      const headers: Record<string, string> = acceptLanguage
        ? { "accept-language": acceptLanguage }
        : {};
      const response = await post(
        "/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        headers,
      );
      expect(response.status).toBe(200);
    }
    await auth.api.sendVerificationOTP({ body: { email: askingDirectly, type: "sign-in" } });

    const subject = (email: string) => {
      const code = codeSentTo(outbox, email);
      return outbox.sent.findLast((sent) => sent.to === email)?.subject.replace(code, "<code>");
    };
    expect(subject(askingIn["pl-PL,pl;q=0.9"])).toBe("<code> to Twój kod logowania");
    expect(subject(askingIn["en;q=0.5, pl;q=0.8"])).toBe("<code> to Twój kod logowania");
    expect(subject(askingIn.de)).toBe("<code> is your sign-in code");
    expect(subject(askingIn[""])).toBe("<code> is your sign-in code");
    expect(subject(askingDirectly)).toBe("<code> is your sign-in code");
  });

  test("a code lasts ten minutes", async () => {
    const [, , email] = asking as [string, string, string];
    const before = Date.now();
    await sendCode(email);
    const { verification } = authTables;
    const ofCode = eq(verification.identifier, `sign-in-otp-${email}`);
    const [issued] = await database.select().from(verification).where(ofCode);
    const lifetime = issued!.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(600_000);
    expect(lifetime).toBeLessThan(605_000);

    // Past it, the code is refused, however right.
    await database
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(ofCode);
    const late = await post("/sign-in/email-otp", { email, otp: codeSentTo(outbox, email) });
    expect(late.status).toBe(400);
    expect(await late.json()).toMatchObject({ code: "OTP_EXPIRED" });
  });

  test("signs in to the same account however often, never making another", async () => {
    // `beforeAll` signed the owner in; a minute later, a second code does the same.
    await database
      .delete(authTables.verification)
      .where(eq(authTables.verification.identifier, `sign-in-code-sent:${owner.email}`));
    const again = await signInWithCode(call, outbox, { email: owner.email, name: "Renamed" });

    const { user } = authTables;
    const accounts = await database.select().from(user).where(eq(user.email, owner.email));
    expect(accounts).toMatchObject([{ id: again.id, name: "Owner" }]);
  });

  test("takes no password, to make an account or to sign in", async () => {
    const credentials = { email: newcomer, password: "correct horse battery", name: "Newcomer" };

    const answers = await Promise.all([
      post("/sign-up/email", credentials),
      post("/sign-in/email", credentials),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([400, 400]);
  });

  test("sends one code a minute per address, however its guesses are spent", async () => {
    const [email] = asking as [string];
    expect((await sendCode(email)).status).toBe(200);
    const wrong = String((Number(codeSentTo(outbox, email)) + 1) % 1_000_000).padStart(6, "0");
    const guesses = [];
    for (let guess = 0; guess < 6; guess++) {
      guesses.push((await post("/sign-in/email-otp", { email, otp: wrong })).status);
    }
    // Five wrong guesses, then the code is spent and its row deleted.
    expect(guesses).toEqual([400, 400, 400, 400, 400, 403]);
    const { verification } = authTables;
    const codes = await database
      .select()
      .from(verification)
      .where(eq(verification.identifier, `sign-in-otp-${email}`));
    expect(codes).toEqual([]);

    // The minute still holds.
    const refused = await sendCode(email.toUpperCase());

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "SIGN_IN_CODE_COOLDOWN" });
  });

  test("sends one code to requests for the same address at once", async () => {
    const [, email] = asking as [string, string];

    const answers = await Promise.all([sendCode(email), sendCode(email), sendCode(email)]);

    expect(answers.map((answer) => answer.status).toSorted((a, b) => a - b)).toEqual([
      200, 429, 429,
    ]);
    expect(outbox.sent.filter((sent) => sent.to === email)).toHaveLength(1);
  });

  test("returns 503 for a failed send without affecting a concurrent send, and keeps the cooldown", async () => {
    const [unsent, unsentDirectly, sentBeside] = asking.slice(3) as [string, string, string];
    // The mail server refuses every address but one, and only while that one
    // is being sent, which then finishes after the refusal: the two overlap.
    const sending = Promise.withResolvers<void>();
    const refused = Promise.withResolvers<void>();
    const failing = createAuth({
      database,
      secret: "test-secret-that-is-long-enough-32",
      baseURL: "http://localhost:3000",
      sendMail: async (mail) => {
        if (mail.to !== sentBeside) {
          await sending.promise;
          refused.resolve();
          throw new Error("SMTP refused the message.");
        }
        sending.resolve();
        await refused.promise;
        await outbox.sendMail(mail);
      },
    });
    const ask = (email: string) =>
      failing.handler(
        new Request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ email, type: "sign-in" }),
        }),
      );

    const [notSent, sent] = await Promise.all([ask(unsent), ask(sentBeside)]);

    expect(notSent.status).toBe(503);
    expect(await notSent.json()).toMatchObject({ code: "SIGN_IN_CODE_SEND_FAILED" });
    // The address still waits its minute: the failure may have been ambiguous.
    const again = await ask(unsent);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ code: "SIGN_IN_CODE_COOLDOWN" });
    expect(sent.status).toBe(200);
    expect(codeSentTo(outbox, sentBeside)).toMatch(/^\d{6}$/);
    await expect(
      failing.api.sendVerificationOTP({ body: { email: unsentDirectly, type: "sign-in" } }),
    ).rejects.toMatchObject({ statusCode: 503, body: { code: "SIGN_IN_CODE_SEND_FAILED" } });
  });

  test("sends sign-in codes only, and answers none of the code's other endpoints", async () => {
    // Each would reset a password, verify, or change an email: flows Braivo
    // does not offer, and the first would give an account a password.
    const others = await Promise.all([
      post("/email-otp/check-verification-otp", { email: owner.email, type: "sign-in", otp: "0" }),
      post("/email-otp/verify-email", { email: owner.email, otp: "0" }),
      post("/email-otp/request-password-reset", { email: owner.email }),
      post("/forget-password/email-otp", { email: owner.email }),
      post("/email-otp/reset-password", { email: owner.email, otp: "0", password: "x".repeat(12) }),
      post("/email-otp/request-email-change", { newEmail: newcomer }, { cookie: ownerCookie }),
      post("/email-otp/change-email", { newEmail: newcomer, otp: "0" }, { cookie: ownerCookie }),
    ]);
    const kinds = await Promise.all(
      ["email-verification", "forget-password"].map((type) => sendCode(owner.email, type)),
    );

    expect(others.map((answer) => answer.status)).toEqual(Array(7).fill(404));
    expect(kinds.map((answer) => answer.status)).toEqual([400, 400]);
  });

  test("the session resolves back to the signed-in user", async () => {
    const session = await call("/get-session", { headers: { cookie: ownerCookie } });

    expect(await session.json()).toMatchObject({ user: { email: owner.email } });
  });

  test("the operator creates an organization owned by an existing account", async () => {
    // Emails are stored lowercased, and an operator may type one otherwise.
    const created = await createOrganization(auth, {
      name: "Example School",
      slug: slugs.school,
      ownerEmail: owner.email.toUpperCase(),
    });

    expect(created).toMatchObject({ name: "Example School", slug: slugs.school });
    expect(await membersOf(created.id)).toMatchObject([{ role: "owner" }]);
  });

  test("says which slug is taken", async () => {
    await createOwned(slugs.taken);

    const again = createOrganization(auth, {
      name: "Another School",
      slug: slugs.taken,
      ownerEmail: owner.email,
    });

    await expect(again).rejects.toThrow(`An organization already has the slug "${slugs.taken}".`);
  });

  test("refuses an organization for an email no account uses", async () => {
    const created = createOrganization(auth, {
      name: "Nobody's",
      slug: slugs.noOwner,
      ownerEmail: "auth-test-nobody@example.com",
    });

    await expect(created).rejects.toThrow("No account uses auth-test-nobody@example.com");
  });

  test("the operator adds an existing account as a learner or an administrator, never owner nor twice", async () => {
    // Named apart from its slug, so the lookup is shown to be by slug, and
    // the messages to name the organization.
    const { id } = await createOrganization(auth, {
      name: "Enrollment School",
      slug: slugs.enrolls,
      ownerEmail: owner.email,
    });
    const learnerCookie = await signIn(learner);

    // Better Auth would store any role; only these two are given.
    for (const role of ["owner", "teacher"]) {
      await expect(
        addMember(auth, { slug: slugs.enrolls, email: learner.email, role }),
      ).rejects.toThrow(`The role must be member or admin, not "${role}".`);
    }
    await expect(
      addMember(auth, {
        slug: slugs.enrolls,
        email: "auth-test-nobody@example.com",
        role: "member",
      }),
    ).rejects.toThrow("No account uses auth-test-nobody@example.com");
    await expect(
      addMember(auth, { slug: "auth-test-no-such-school", email: learner.email, role: "member" }),
    ).rejects.toThrow('No organization has the slug "auth-test-no-such-school".');

    const added = await addMember(auth, {
      slug: slugs.enrolls,
      email: learner.email.toUpperCase(),
      role: "member",
    });
    expect(added).toEqual({
      organization: { name: "Enrollment School", slug: slugs.enrolls },
      role: "member",
    });
    // The learner's own session now lists the organization.
    const listed = await call("/organization/list", { headers: { cookie: learnerCookie } });
    expect(await listed.json()).toMatchObject([{ slug: slugs.enrolls }]);

    // A second membership would leave the role as it was, so it is refused.
    await expect(
      addMember(auth, { slug: slugs.enrolls, email: learner.email, role: "admin" }),
    ).rejects.toThrow(`${learner.email} is already a member of Enrollment School.`);
    expect((await membersOf(id)).map(({ role }) => role).toSorted()).toEqual(["member", "owner"]);

    const other = await createOwned(slugs.adminAdded);
    await addMember(auth, { slug: slugs.adminAdded, email: learner.email, role: "admin" });
    expect((await membersOf(other)).map(({ role }) => role).toSorted()).toEqual(["admin", "owner"]);
  });

  test("refuses creating an organization from a browser session", async () => {
    const created = await post(
      "/organization/create",
      { name: "Self-Serve", slug: slugs.selfServe },
      { cookie: ownerCookie },
    );

    expect(created.status).toBe(403);
    expect(await created.json()).toMatchObject({
      code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
    });
  });

  test("refuses an HTTP request that names an owner instead of signing in", async () => {
    // The operator's call is trusted because it has no request; pins that
    // Better Auth still refuses one that does (ADR 0006's pinned version).
    const [stored] = await database
      .select({ id: authTables.user.id })
      .from(authTables.user)
      .where(eq(authTables.user.email, owner.email));

    const created = await post("/organization/create", {
      name: "Impostor",
      slug: slugs.selfServe,
      userId: stored?.id,
    });

    expect(created.status).toBe(401);
  });

  test("answers none of Better Auth's invitation endpoints, and stored invitations stay pending", async () => {
    // Each request, from the account it expects, succeeds without the switch,
    // so only the switch refuses it.
    const id = await createOwned(slugs.invites);
    const [inviter] = await membersOf(id);
    // Named once, so a request cannot drift from the invitation it answers.
    const invitationIds = {
      accept: "auth-test-accept",
      reject: "auth-test-reject",
      cancel: "auth-test-cancel",
      get: "auth-test-get",
    };
    await database.insert(authTables.invitation).values(
      Object.values(invitationIds).map((invitationId) => ({
        id: invitationId,
        organizationId: id,
        email: invitee.email,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
        inviterId: inviter!.userId,
      })),
    );
    // Signing in by code verifies the email, as listing one's own invitations needs.
    const ownerHeaders = { cookie: ownerCookie };
    const inviteeHeaders = { cookie: await signIn(invitee) };

    const answers = await Promise.all([
      post(
        "/organization/invite-member",
        { organizationId: id, email: newcomer, role: "member" },
        ownerHeaders,
      ),
      post("/organization/cancel-invitation", { invitationId: invitationIds.cancel }, ownerHeaders),
      call(`/organization/list-invitations?organizationId=${id}`, { headers: ownerHeaders }),
      post(
        "/organization/accept-invitation",
        { invitationId: invitationIds.accept },
        inviteeHeaders,
      ),
      post(
        "/organization/reject-invitation",
        { invitationId: invitationIds.reject },
        inviteeHeaders,
      ),
      call(`/organization/get-invitation?id=${invitationIds.get}`, { headers: inviteeHeaders }),
      call("/organization/list-user-invitations", { headers: inviteeHeaders }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual(Array(7).fill(404));
    const { invitation } = authTables;
    const stored = await database
      .select({ id: invitation.id, status: invitation.status })
      .from(invitation)
      .where(eq(invitation.organizationId, id));
    expect(stored.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
      Object.values(invitationIds)
        .toSorted()
        .map((invitationId) => ({ id: invitationId, status: "pending" })),
    );
    expect((await membersOf(id)).map((member) => member.userId)).toEqual([inviter!.userId]);
  });

  test("answers no member listing, role, removal, or role change, to a learner or the owner", async () => {
    // Without the switch, either reads all three, and removing or updating
    // someone unknown answers 400: only the switch answers 404.
    const id = await createOwned(slugs.roster);
    const [own] = await membersOf(id);
    const headers = { cookie: ownerCookie };
    const statuses = async () =>
      (
        await Promise.all([
          call(`/organization/list-members?organizationId=${id}`, { headers }),
          call(`/organization/get-full-organization?organizationId=${id}`, { headers }),
          call(`/organization/get-active-member-role?organizationId=${id}&userId=${own!.userId}`, {
            headers,
          }),
          post(
            "/organization/remove-member",
            { organizationId: id, memberIdOrEmail: "auth-test-nobody@example.com" },
            headers,
          ),
          post(
            "/organization/update-member-role",
            { organizationId: id, memberId: "auth-test-nobody", role: "admin" },
            headers,
          ),
        ])
      ).map((answer) => answer.status);

    expect(await statuses()).toEqual(Array(5).fill(404));
    await database
      .update(authTables.member)
      .set({ role: "member" })
      .where(eq(authTables.member.id, own!.id));
    expect(await statuses()).toEqual(Array(5).fill(404));
  });

  test.each([
    ["a reserved slug", slugs.reserved],
    ["a malformed slug", slugs.malformed],
  ])("refuses %s", async (_case, slug) => {
    const created = createOrganization(auth, { name: "Refused", slug, ownerEmail: owner.email });

    await expect(created).rejects.toMatchObject({
      body: { code: "ORGANIZATION_SLUG_NOT_ALLOWED" },
    });
  });

  test("refuses changing a slug, but not resending it with other changes", async () => {
    const cookie = ownerCookie;
    const id = await createOwned(slugs.renamed);
    const update = (data: Record<string, string>) =>
      post("/organization/update", { organizationId: id, data }, { cookie });

    const changed = await update({ slug: slugs.renamedAgain });
    const resent = await update({ name: "Renamed School", slug: slugs.renamed });

    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ code: "ORGANIZATION_SLUG_IMMUTABLE" });
    expect(resent.status).toBe(200);
    const { organization } = authTables;
    const [stored] = await database.select().from(organization).where(eq(organization.id, id));
    expect(stored).toMatchObject({ name: "Renamed School", slug: slugs.renamed });
  });

  test("trusts the installation's origin alone, not even an organization's domain", async () => {
    // Better Auth checks the origin of a request carrying a session; a code
    // sign-in, which carries none, is the API's to check (`api/app.ts`). A
    // learn domain holds learner sessions, never the account's (ADR 0018).
    const id = await createOwned(slugs.hasDomain);
    await database
      .insert(organizationDomain)
      .values({ hostname: "auth-test.example.com", organizationId: id });
    const rename = (origin: string) =>
      post("/update-user", { name: owner.name }, { cookie: ownerCookie, origin });

    expect((await rename("http://localhost:3000")).status).toBe(200);
    expect((await rename("https://auth-test.example.com")).status).toBe(403);
    expect((await rename("https://evil.example")).status).toBe(403);
  });

  test("refuses an organization write from a foreign origin", async () => {
    // Pins `disableOriginCheck: false`: without it, Better Auth skips this check
    // whenever `NODE_ENV` is `test`, and this would pass.
    const id = await createOwned(slugs.foreignOrigin);

    const updated = await post(
      "/organization/update",
      { organizationId: id, data: { name: "Foreign Origin" } },
      { cookie: ownerCookie, origin: "https://evil.example" },
    );

    expect(updated.status).toBe(403);
  });

  test("refuses to delete an organization that still owns learning content", async () => {
    // The 409 distinguishes the hook from the underlying foreign key's refusal.
    const cookie = ownerCookie;
    const id = await createOwned(slugs.ownsContent);
    await createObjectives(database, id, ["Blocks deletion"]);
    const before = await membersOf(id);

    const deleted = await post("/organization/delete", { organizationId: id }, { cookie });

    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ code: "ORGANIZATION_OWNS_LEARNING_CONTENT" });
    expect(before).toHaveLength(1);
    expect(await membersOf(id)).toEqual(before);
  });

  test("the adapter createAuth configures rolls back a failed transaction", async () => {
    // Better Auth's organization delete runs its steps in this transaction, so
    // a foreign key refusing the last one leaves the members in place. That the
    // endpoint still uses it is a pinned-version assumption (ADR 0006).
    const id = await createOwned(slugs.halfDeleted);
    await createObjectives(database, id, ["Refuses the last step"]);
    const before = await membersOf(id);

    const { adapter } = await auth.$context;
    const refused = await adapter
      .transaction(async (tx) => {
        await tx.deleteMany({ model: "member", where: [{ field: "organizationId", value: id }] });
        await tx.delete({ model: "organization", where: [{ field: "id", value: id }] });
      })
      .catch((thrown: unknown) => thrown);

    // Named, not merely thrown: a mistyped model would also reject and roll back.
    expect(testing.violatedConstraint(refused)).toBe(
      "objective_organization_id_organization_id_fkey",
    );
    expect(before).toHaveLength(1);
    expect(await membersOf(id)).toEqual(before);
  });

  test("deletes an organization that owns nothing", async () => {
    // Without this, a guard that refused every deletion would pass the tests
    // above.
    const cookie = ownerCookie;
    const id = await createOwned(slugs.ownsNothing);

    const deleted = await post("/organization/delete", { organizationId: id }, { cookie });

    expect(deleted.status).toBe(200);
    const { organization } = authTables;
    expect(await database.select().from(organization).where(eq(organization.id, id))).toEqual([]);
    expect(await membersOf(id)).toEqual([]);
  });
});
