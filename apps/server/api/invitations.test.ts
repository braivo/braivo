// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Inviting a learner, an author, or an administrator, over HTTP (ADR 0018,
// access-27, 50 to 54): who invites whom, the mail and its failure, who lists
// invitations, what the page reads with and without a session, who accepts,
// and a learner's way on to the learn domain.

import { runMigrations } from "@braivo/db";
import {
  invitation,
  invitationMailClaim,
  member,
  organization,
  organizationDomain,
  user,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, count, eq, gt } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  inviteToOrganization,
  NotPermitted,
  registerLearnDomain,
  resendInvitation,
  SignedOut,
} from "../application/index.ts";
import {
  baseUrl,
  connectionString,
  createTestApi,
  learnerSessionOn,
  type Signed,
} from "./testing.ts";

const { database, api, outbox, signUp, signUpAs } = createTestApi();

const organizationId = "invitations-api-org";
const invitationsPath = `/api/organizations/${organizationId}/invitations`;
const at = new Date("2026-06-01T00:00:00.000Z");
/** The organization's learn domain, registered by the tests that need one. */
const learnOrigin = "https://invitations-test.example.com";
const learnHostname = new URL(learnOrigin).hostname;
const registerLearnSite = () =>
  registerLearnDomain({
    database,
    baseUrl,
    organizationSlug: organizationId,
    hostname: learnHostname,
  });
const removeLearnSites = () =>
  database.delete(organizationDomain).where(eq(organizationDomain.organizationId, organizationId));
const DAY = 86_400_000;

let owner!: Signed;
let admin!: Signed;
let author!: Signed;
let learner!: Signed;

const cookieOf = (signed: Signed) => ({ cookie: signed.cookie, origin: baseUrl });
const request = (
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
) =>
  api.request(url, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const invite = (by: Signed, body: unknown, headers: Record<string, string> = {}) =>
  request("POST", invitationsPath, { ...cookieOf(by), ...headers }, body);
const accept = (by: Signed, invitationId: string) =>
  request("POST", "/api/auth/organization/accept-invitation", cookieOf(by), { invitationId });
const preview = (invitationId: string, headers: Record<string, string> = {}) =>
  request("GET", `/api/invitations/${invitationId}`, headers);

/** A fresh address, so a rerun meets no account, invitation, or code's minute left behind. */
const newEmail = () => `invited-${crypto.randomUUID()}@example.com`;

/** One address's result in a submission's answer, which must be a 200. */
type Result = {
  email: string;
  outcome: string;
  code?: string;
  role?: string;
  roles?: string[];
  invitation?: { id: string; email: string; role: string; expiresAt: string };
  emailSent?: boolean;
};
async function resultsOf(answered: Response): Promise<Result[]> {
  expect(answered.status).toBe(200);
  return ((await answered.json()) as { results: Result[] }).results;
}
const onlyResult = async (answered: Response) => (await resultsOf(answered))[0]!;

/** Invites `email` as `role` by the admin, answering the invitation's ID. */
async function invited(email: string, role = "author"): Promise<string> {
  const result = await onlyResult(await invite(admin, { emails: [email], role }));
  expect(result).toMatchObject({ email, outcome: "invited" });
  return result.invitation!.id;
}

/** The invitation mails counted against an address's daily bound. */
const mailsTo = async (email: string) =>
  (
    await database
      .select({ count: count() })
      .from(invitationMailClaim)
      .where(eq(invitationMailClaim.email, email))
  )[0]!.count;

/** Mails counted as sent `minutesAgo`, to `email`, by this organization. */
const mailedBefore = (rows: { email: string; minutesAgo: number }[]) =>
  database.insert(invitationMailClaim).values(
    rows.map(({ email, minutesAgo }) => ({
      email,
      organizationId,
      claimedAt: new Date(Date.now() - minutesAgo * 60_000),
    })),
  );

const resend = (by: Signed, invitationId: string, headers: Record<string, string> = {}) =>
  request("POST", `${invitationsPath}/${invitationId}/resend`, { ...cookieOf(by), ...headers });

const storedInvitation = async (id: string) =>
  (await database.select().from(invitation).where(eq(invitation.id, id)))[0];

const rolesOf = async (userId: string) =>
  (
    await database
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
  ).map(({ role }) => role);

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("invitations, over HTTP", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    [owner, admin, author, learner] = await Promise.all([signUp(), signUp(), signUp(), signUp()]);
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [author.id, learner.id],
      adminIds: [owner.id, admin.id],
      at,
    });
    // Named as the tests expect, whatever an earlier run left.
    await database
      .update(organization)
      .set({ name: organizationId })
      .where(eq(organization.id, organizationId));
    for (const [signed, role] of [
      [owner, "owner"],
      [author, "author"],
    ] as const) {
      await database
        .update(member)
        .set({ role })
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, signed.id)));
    }
  });

  beforeEach(async () => {
    await database.delete(invitation).where(eq(invitation.organizationId, organizationId));
    await removeLearnSites();
    await database
      .delete(invitationMailClaim)
      .where(eq(invitationMailClaim.organizationId, organizationId));
    outbox.failTo.clear();
  });

  test("an owner or admin invites an author or administrator for 7 days, and mails them", async () => {
    const email = newEmail();
    const before = Date.now();

    const body = await onlyResult(
      await invite(owner, { emails: [`  ${email.toUpperCase()} `], role: "author" }),
    );

    expect(body).toMatchObject({
      email,
      outcome: "invited",
      invitation: { email, role: "author" },
      emailSent: true,
    });
    const expiresAt = Date.parse(body.invitation!.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    const mail = outbox.sent.findLast((sent) => sent.to === email);
    // The school, the inviter, the role in plain words, and the link.
    expect(mail?.subject).toContain(organizationId);
    expect(mail?.text).toContain(owner.name);
    expect(mail?.text).toContain(`${baseUrl}/invitations/${body.invitation!.id}`);
    expect(mail?.text).toMatch(/manage and publish/i);
    expect(
      await onlyResult(await invite(admin, { emails: [newEmail()], role: "admin" })),
    ).toMatchObject({ outcome: "invited" });
  });

  test("mails in the inviter's language", async () => {
    const email = newEmail();

    await invite(
      admin,
      { emails: [email], role: "admin" },
      { "accept-language": "pl-PL,pl;q=0.9" },
    );

    expect(outbox.sent.findLast((sent) => sent.to === email)?.subject).toMatch(/zaprasza/);
  });

  test("refuses an owner invitation, and roles not offered", async () => {
    for (const role of ["owner", "teacher", ["author", "admin"], "author,admin", "member,admin"]) {
      const answered = await invite(owner, { emails: [newEmail()], role });

      expect(answered.status).toBe(400);
      expect(await answered.json()).toMatchObject({ code: "ROLE_NOT_INVITABLE" });
    }
    for (const emails of [
      undefined,
      [],
      ["  "],
      "a@example.com",
      [42],
      Array(1001).fill("a@b.c"),
    ]) {
      const answered = await invite(owner, { emails, role: "author" });

      expect(answered.status).toBe(400);
      expect(await answered.json()).toMatchObject({ code: "EMAILS_INVALID" });
    }
    expect(
      await database.select().from(invitation).where(eq(invitation.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("refuses an author, a learner, a stranger, and a tool inviting", async () => {
    const stranger = await signUp();

    for (const signed of [author, learner, stranger]) {
      expect((await invite(signed, { emails: [newEmail()], role: "author" })).status).toBe(403);
    }
    const token = await request(
      "POST",
      invitationsPath,
      { authorization: `Bearer ${admin.token}` },
      { emails: [newEmail()], role: "author" },
    );
    expect(token.status).toBe(403);
    expect(
      (await request("POST", invitationsPath, {}, { emails: [newEmail()], role: "author" })).status,
    ).toBe(401);
    expect(
      await database.select().from(invitation).where(eq(invitation.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("reports an address already a member, or already invited, keeping what is there", async () => {
    const email = newEmail();
    await invited(email, "admin");

    const results = await resultsOf(
      await invite(owner, { emails: [email, author.email], role: "author" }),
    );

    expect(results).toEqual([
      { email, outcome: "already invited", role: "admin" },
      { email: author.email, outcome: "already a member", roles: ["author"] },
    ]);
    expect(await rolesOf(author.id)).toEqual(["author"]);
  });

  test("refuses a submission whole, trying no further address, once the actor may not invite", async () => {
    // As `createInvitation` reports the actor demoted or removed, or the
    // session ended, since the check: each refusal kept, a 403 or a 401.
    for (const refusal of [
      new NotPermitted("May not invite to this organization."),
      new SignedOut("The session ended."),
    ]) {
      const create = vi.fn(async () => {
        throw refusal;
      });

      await expect(
        inviteToOrganization({
          database,
          organizationId,
          actingAs: admin.id,
          emails: Array.from({ length: 12 }, newEmail),
          role: "author",
          create,
          memberLimit: 1_000,
          now: () => new Date(),
        }),
      ).rejects.toBe(refusal);
      // Only the addresses already under way, five at a time, were tried.
      expect(create.mock.calls.length).toBeLessThanOrEqual(5);
    }
  });

  test("refuses the 1,001st invitation waiting, counting no expired one, mailing nothing", async () => {
    const row = (index: number, expiresAt: Date) => ({
      id: `invitations-api-cap-${index}`,
      organizationId,
      email: `cap-${index}@example.com`,
      role: "author",
      status: "pending",
      expiresAt,
      createdAt: new Date(),
      inviterId: admin.id,
    });
    const later = new Date(Date.now() + DAY);
    // 999 waiting, and expired ones past Better Auth's 100-row read, which must not count.
    await database
      .insert(invitation)
      .values([
        ...Array.from({ length: 999 }, (_, index) => row(index, later)),
        ...Array.from({ length: 150 }, (_, index) => row(1000 + index, new Date(Date.now() - DAY))),
      ]);

    // One after another: the cap is checked, then written, not atomically, so
    // addresses invited at once may pass it by a few (ADR 0018).
    expect(
      await onlyResult(await invite(admin, { emails: [newEmail()], role: "author" })),
    ).toMatchObject({ outcome: "invited" });
    const refusedEmail = newEmail();
    expect(
      await onlyResult(await invite(admin, { emails: [refusedEmail], role: "author" })),
    ).toEqual({
      email: refusedEmail,
      outcome: "refused",
      code: "PENDING_LIMIT",
    });
    expect(outbox.sent.some((sent) => sent.to === refusedEmail)).toBe(false);
    // Refused before its mail: the address may still be mailed three times today.
    expect(await mailsTo(refusedEmail)).toBe(0);
  });

  test("finds a waiting invitation for an address behind a hundred expired ones", async () => {
    const email = newEmail();
    await database.insert(invitation).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: `invitations-api-stale-${index}`,
        organizationId,
        email,
        role: "author",
        status: "pending",
        expiresAt: new Date(Date.now() - DAY),
        createdAt: new Date(),
        inviterId: admin.id,
      })),
    );
    await invited(email, "admin");

    const again = await onlyResult(await invite(owner, { emails: [email], role: "author" }));

    expect(again).toEqual({ email, outcome: "already invited", role: "admin" });
  });

  test("reports an invitation whose mail could not be sent apart from a refusal", async () => {
    const email = newEmail();
    outbox.failTo.add(email);

    const { invitation: made, emailSent } = await onlyResult(
      await invite(admin, { emails: [email], role: "author" }),
    );

    expect(emailSent).toBe(false);
    // Stored all the same, its link still good to copy, and counted: a send was tried.
    expect((await preview(made!.id)).status).toBe(200);
    expect(await mailsTo(email)).toBe(1);
  });

  test("lists pending invitations to an owner or admin alone, Better Auth's listing closed", async () => {
    const email = newEmail();
    await invited(email, "admin");
    const expiredId = await invited(newEmail());
    await database
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, expiredId));

    const listed = await request("GET", invitationsPath, cookieOf(owner));

    expect(listed.status).toBe(200);
    const [members] = await database
      .select({ count: count() })
      .from(member)
      .where(eq(member.organizationId, organizationId));
    expect(await listed.json()).toEqual({
      // Invitations hold no places: room is counted by members alone.
      membersLeft: 1000 - members!.count,
      invitations: [
        {
          id: expect.any(String),
          email,
          role: "admin",
          inviter: { name: admin.name },
          expiresAt: expect.any(String),
        },
      ],
    });
    for (const signed of [author, learner]) {
      expect((await request("GET", invitationsPath, cookieOf(signed))).status).toBe(403);
    }
    const token = await request("GET", invitationsPath, { authorization: `Bearer ${owner.token}` });
    expect(token.status).toBe(403);
    const betterAuths = await request(
      "GET",
      `/api/auth/organization/list-invitations?organizationId=${organizationId}`,
      cookieOf(learner),
    );
    expect(betterAuths.status).toBe(404);
  });

  test("shows someone signed out the school's name and the invitation's state, nothing else", async () => {
    const id = await invited(newEmail());

    const signedOut = await preview(id);

    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({
      organization: { name: organizationId },
      status: "pending",
    });
    const unknown = await preview("no-such-invitation");
    expect(unknown.status).toBe(404);
    await database
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, id));
    expect(await (await preview(id)).json()).toEqual({
      organization: { name: organizationId },
      status: "expired",
    });
    await database.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, id));
    expect(await (await preview(id)).json()).toMatchObject({ status: "canceled" });
  });

  test("shows the recipient the role and the inviter, and another account only that it is not theirs", async () => {
    const email = newEmail();
    const id = await invited(email, "admin");
    const recipient = await signUpAs(email, "Ada Recipient");

    const theirs = await preview(id, cookieOf(recipient));
    const another = await preview(id, cookieOf(learner));

    expect(await theirs.json()).toEqual({
      organization: { name: organizationId, slug: organizationId },
      status: "pending",
      recipient: true,
      member: false,
      role: "admin",
      inviter: { name: admin.name },
    });
    expect(await another.json()).toEqual({
      organization: { name: organizationId },
      status: "pending",
      recipient: false,
    });
  });

  test("lets only the invited email, verified, accept, as the invited role", async () => {
    const email = newEmail();
    const id = await invited(email, "author");
    const recipient = await signUpAs(email, "Ada Recipient");

    const mismatched = await accept(learner, id);
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toMatchObject({
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    });
    await database.update(user).set({ emailVerified: false }).where(eq(user.id, recipient.id));
    const unverified = await accept(recipient, id);
    expect(unverified.status).toBe(403);
    expect(await rolesOf(recipient.id)).toEqual([]);
    await database.update(user).set({ emailVerified: true }).where(eq(user.id, recipient.id));

    const accepted = await accept(recipient, id);

    expect(accepted.status).toBe(200);
    expect(await rolesOf(recipient.id)).toEqual(["author"]);
    expect(await (await preview(id, cookieOf(recipient))).json()).toMatchObject({
      status: "accepted",
      recipient: true,
    });
    expect((await accept(recipient, id)).status).toBe(400);
  });

  test("keeps one invitation and one mail per address when two submissions name it at once", async () => {
    const email = newEmail();

    const answers = await Promise.all([
      invite(admin, { emails: [email], role: "author" }),
      invite(owner, { emails: [email], role: "admin" }),
    ]);

    const results = await Promise.all(answers.map(onlyResult));
    expect(results.filter((each) => each.outcome === "invited")).toHaveLength(1);
    // The other is held back by the address's mail bound, or finds it invited.
    const other = results.find((each) => each.outcome !== "invited")!;
    expect(["already invited", "RECIPIENT_COOLDOWN"]).toContain(other.code ?? other.outcome);
    const kept = await database
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.email, email), eq(invitation.status, "pending")));
    expect(kept).toHaveLength(1);
    expect(outbox.sent.filter((sent) => sent.to === email)).toHaveLength(1);
  });

  test("lets either of two invitations to one address made at once be accepted, the other then finding a member", async () => {
    const email = newEmail();
    const [earlier, later] = [crypto.randomUUID(), crypto.randomUUID()];
    const offer = (id: string, role: string, createdAt: Date) => ({
      id,
      organizationId,
      email,
      role,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * DAY),
      createdAt,
      inviterId: admin.id,
    });
    // As Better Auth, checking before its insert, may store two made at once
    // past the route's mail claim, as by a process stopped between them.
    await database
      .insert(invitation)
      .values([
        offer(earlier, "author", new Date(Date.now() - 1000)),
        offer(later, "admin", new Date()),
      ]);
    const recipient = await signUpAs(email, "Ada Recipient");

    expect((await accept(recipient, later)).status).toBe(200);
    const refused = await accept(recipient, earlier);

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    });
    expect(await rolesOf(recipient.id)).toEqual(["admin"]);
  });

  test("tells a member already there, by another way, that they belong, keeping their role", async () => {
    const email = newEmail();
    const id = await invited(email, "admin");
    const recipient = await signUpAs(email, "Ada Recipient");
    // As the operator's `add-member` does, after the invitation was sent.
    await database.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: recipient.id,
      role: "author",
      createdAt: new Date(),
    });

    expect(await (await preview(id, cookieOf(recipient))).json()).toMatchObject({
      status: "pending",
      recipient: true,
      member: true,
    });
    const accepted = await accept(recipient, id);

    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toMatchObject({
      code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    });
    expect(await rolesOf(recipient.id)).toEqual(["author"]);
  });

  test("invites a learner only while the organization has a learn domain", async () => {
    const email = newEmail();

    const refused = await invite(admin, { emails: [email], role: "member" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "NO_LEARN_DOMAIN" });
    expect(
      await database.select().from(invitation).where(eq(invitation.organizationId, organizationId)),
    ).toEqual([]);
    expect(outbox.sent.some((sent) => sent.to === email)).toBe(false);

    await registerLearnSite();
    const answered = await onlyResult(await invite(admin, { emails: [email], role: "member" }));

    expect(answered).toMatchObject({ outcome: "invited", invitation: { role: "member" } });
    expect(outbox.sent.findLast((sent) => sent.to === email)?.text).toMatch(/as a learner/i);
  });

  test("refuses accepting a learner invitation while the learn domain is gone, keeping it pending", async () => {
    await registerLearnSite();
    const email = newEmail();
    const id = await invited(email, "member");
    const recipient = await signUpAs(email, "Ada Learner");
    await removeLearnSites();

    const refused = await accept(recipient, id);

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "NO_LEARN_DOMAIN" });
    expect(await rolesOf(recipient.id)).toEqual([]);
    const [stored] = await database
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id));
    expect(stored?.status).toBe("pending");
    expect(await (await preview(id, cookieOf(recipient))).json()).toMatchObject({
      status: "pending",
      learnDomain: null,
    });

    await registerLearnSite();
    expect((await accept(recipient, id)).status).toBe(200);
    expect(await rolesOf(recipient.id)).toEqual(["member"]);
  });

  test("a learner accepts on the installation's origin, then is handed to the learn domain without a second code", async () => {
    await registerLearnSite();
    const email = newEmail();
    const id = await invited(email, "member");
    const recipient = await signUpAs(email, "Ada Learner");
    const codesBefore = outbox.sent.filter((sent) => sent.to === email).length;

    // Only the recipient learns where it leads.
    expect(await (await preview(id, cookieOf(recipient))).json()).toMatchObject({
      role: "member",
      learnDomain: learnHostname,
    });
    expect(await (await preview(id, cookieOf(learner))).json()).not.toHaveProperty("learnDomain");
    expect(await (await preview(id)).json()).not.toHaveProperty("learnDomain");
    expect((await accept(recipient, id)).status).toBe(200);

    // The learn domain's own handoff start, its nonce cookie, then the code.
    const learnerCookie = await learnerSessionOn(api, learnOrigin, recipient.cookie);
    const session = await api.request(`${learnOrigin}/api/session`, {
      headers: { cookie: learnerCookie },
    });

    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: recipient.id, name: "Ada Learner" } });
    expect(outbox.sent.filter((sent) => sent.to === email)).toHaveLength(codesBefore);
    // Accepted, the page still leads there: the way to try again.
    expect(await (await preview(id, cookieOf(recipient))).json()).toMatchObject({
      status: "accepted",
      learnDomain: learnHostname,
    });
  });

  test("invites up to 100 distinct addresses at once, duplicates and case collapsed", async () => {
    const first = newEmail();
    const second = newEmail();

    const results = await resultsOf(
      await invite(admin, {
        emails: [first.toUpperCase(), ` ${first} `, second, "", first],
        role: "author",
      }),
    );

    expect(results.map(({ email, outcome }) => [email, outcome])).toEqual([
      [first, "invited"],
      [second, "invited"],
    ]);
    const hundredAndOne = Array.from({ length: 101 }, () => newEmail());
    const tooMany = await invite(admin, { emails: hundredAndOne, role: "author" });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "TOO_MANY_ADDRESSES" });
    // Distinct ones counted: 100 and their repeats pass.
    const hundred = hundredAndOne.slice(0, 100);
    const allHundred = await resultsOf(
      await invite(admin, { emails: [...hundred, hundred[0]!.toUpperCase()], role: "author" }),
    );
    expect(allHundred).toHaveLength(100);
    expect(allHundred.every(({ outcome }) => outcome === "invited")).toBe(true);
  });

  test("reports each address of a mixed submission, in order", async () => {
    const fresh = newEmail();
    const unmailed = newEmail();
    const waiting = newEmail();
    await invited(waiting, "admin");
    outbox.failTo.add(unmailed);
    const bounded = newEmail();
    await mailedBefore([10, 20, 30].map((minutesAgo) => ({ email: bounded, minutesAgo })));

    const results = await resultsOf(
      await invite(admin, {
        emails: [fresh, "not an email", waiting, author.email, unmailed, bounded],
        role: "author",
      }),
    );

    expect(results).toEqual([
      expect.objectContaining({ email: fresh, outcome: "invited", emailSent: true }),
      { email: "not an email", outcome: "refused", code: "EMAIL_INVALID" },
      { email: waiting, outcome: "already invited", role: "admin" },
      { email: author.email, outcome: "already a member", roles: ["author"] },
      expect.objectContaining({ email: unmailed, outcome: "invited", emailSent: false }),
      { email: bounded, outcome: "refused", code: "RECIPIENT_DAILY_LIMIT" },
    ]);
  });

  test("mails an address at most three times a day across organizations, refusals not counted", async () => {
    const email = newEmail();
    // Two today, one by another organization's invitation: counted for the address, not by organization.
    await mailedBefore([{ email, minutesAgo: 60 * 23 }]);
    await database.insert(invitationMailClaim).values({
      email,
      organizationId: null,
      claimedAt: new Date(Date.now() - 120 * 60_000),
    });
    const yesterday = { email, minutesAgo: 60 * 24 + 5 };
    await mailedBefore([yesterday]);

    const third = await onlyResult(await invite(admin, { emails: [email], role: "author" }));
    expect(third).toMatchObject({ outcome: "invited", emailSent: true });
    await database.delete(invitation).where(eq(invitation.id, third.invitation!.id));
    // Past the minute between two, so only the day's bound speaks.
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 5 * 60_000) })
      .where(
        and(
          eq(invitationMailClaim.email, email),
          eq(invitationMailClaim.organizationId, organizationId),
        ),
      );

    const fourth = await onlyResult(await invite(admin, { emails: [email], role: "author" }));

    expect(fourth).toEqual({ email, outcome: "refused", code: "RECIPIENT_DAILY_LIMIT" });
    expect(outbox.sent.filter((sent) => sent.to === email)).toHaveLength(1);
    expect(await database.select().from(invitation).where(eq(invitation.email, email))).toEqual([]);
    // The day's three; the refusal added none.
    const [today] = await database
      .select({ count: count() })
      .from(invitationMailClaim)
      .where(
        and(
          eq(invitationMailClaim.email, email),
          gt(invitationMailClaim.claimedAt, new Date(Date.now() - DAY)),
        ),
      );
    expect(today?.count).toBe(3);
  });

  test("refuses a resend within a minute of the last mail, counting nothing, and resends after it", async () => {
    const email = newEmail();
    const id = await invited(email);
    const before = await storedInvitation(id);

    const tooSoon = await resend(admin, id);

    expect(tooSoon.status).toBe(429);
    expect(await tooSoon.json()).toMatchObject({ code: "RECIPIENT_COOLDOWN" });
    expect(await mailsTo(email)).toBe(1);
    expect((await storedInvitation(id))?.expiresAt).toEqual(before?.expiresAt);
    expect(outbox.sent.filter((sent) => sent.to === email)).toHaveLength(1);
  });

  test("resends the same link and role, its expiry renewed, mailing it again", async () => {
    const email = newEmail();
    const id = await invited(email, "admin");
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));
    await database
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() + DAY) })
      .where(eq(invitation.id, id));

    const answered = await resend(owner, id, { "accept-language": "pl" });

    expect(answered.status).toBe(200);
    const body = (await answered.json()) as Result;
    expect(body).toMatchObject({
      outcome: "invited",
      invitation: { id, email, role: "admin" },
      emailSent: true,
    });
    expect(Date.parse(body.invitation!.expiresAt)).toBeGreaterThan(Date.now() + 7 * DAY - 60_000);
    expect((await storedInvitation(id))?.expiresAt.getTime()).toBe(
      Date.parse(body.invitation!.expiresAt),
    );
    const mail = outbox.sent.findLast((sent) => sent.to === email);
    expect(mail?.text).toContain(`${baseUrl}/invitations/${id}`);
    expect(mail?.subject).toMatch(/zaprasza/);
    expect(mail?.text).toContain(owner.name);
    expect(await mailsTo(email)).toBe(2);
  });

  test("resends a live invitation hidden behind a hundred expired ones for the same address", async () => {
    const email = newEmail();
    await database.insert(invitation).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: `invitations-api-resend-stale-${index}`,
        organizationId,
        email,
        role: "author",
        status: "pending",
        expiresAt: new Date(Date.now() - DAY),
        createdAt: new Date(),
        inviterId: admin.id,
      })),
    );
    const id = await invited(email, "admin");
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));

    const answered = await resend(admin, id);

    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ invitation: { id }, emailSent: true });
  });

  test("invites an expired address again, with a new link", async () => {
    const email = newEmail();
    const id = await invited(email);
    await database
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, id));
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));

    const answered = await resend(admin, id);

    expect(answered.status).toBe(200);
    const body = (await answered.json()) as Result;
    expect(body).toMatchObject({ outcome: "invited", invitation: { email, role: "author" } });
    expect(body.invitation!.id).not.toBe(id);
    expect(outbox.sent.findLast((sent) => sent.to === email)?.text).toContain(
      `/invitations/${body.invitation!.id}`,
    );
    // Inviting it from the form does the same, once the minute between two has passed.
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));
    await database
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, body.invitation!.id));
    const again = await onlyResult(await invite(admin, { emails: [email], role: "author" }));
    expect(again).toMatchObject({ outcome: "invited" });
    expect(again.invitation!.id).not.toBe(body.invitation!.id);
  });

  test("resends only a pending invitation of this organization, for its owner or admin, a learner's while it has a learn domain", async () => {
    const email = newEmail();
    const id = await invited(email);
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));

    for (const signed of [author, learner]) expect((await resend(signed, id)).status).toBe(403);
    expect(
      (
        await request("POST", `${invitationsPath}/${id}/resend`, {
          authorization: `Bearer ${admin.token}`,
        })
      ).status,
    ).toBe(403);
    expect((await resend(admin, "no-such-invitation")).status).toBe(404);
    const elsewhere = await request(
      "POST",
      `/api/organizations/another-organization/invitations/${id}/resend`,
      cookieOf(admin),
    );
    expect([403, 404]).toContain(elsewhere.status);
    await database.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, id));
    const cancelled = await resend(admin, id);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ code: "NOT_PENDING" });

    await registerLearnSite();
    const learnerEmail = newEmail();
    const learnerId = await invited(learnerEmail, "member");
    await removeLearnSites();
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, learnerEmail));
    const noSite = await resend(admin, learnerId);
    expect(noSite.status).toBe(409);
    expect(await noSite.json()).toMatchObject({ code: "NO_LEARN_DOMAIN" });
    expect(await mailsTo(learnerEmail)).toBe(1);
  });

  test("lets a submission and a resend wait on their mail past Bun's idle timeout", async () => {
    const email = newEmail();
    const timeout = vi.fn();
    const post = (path: string, body?: unknown) =>
      api.request(
        path,
        {
          method: "POST",
          headers: { ...cookieOf(admin), "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { timeout },
      );

    expect((await post(invitationsPath, { emails: [email], role: "author" })).status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    timeout.mockClear();
    const [made] = await database.select().from(invitation).where(eq(invitation.email, email));
    await post(`${invitationsPath}/${made!.id}/resend`);
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);
  });

  test("uncounts a resend's mail when renewing fails before any mail is tried", async () => {
    const email = newEmail();
    const id = await invited(email);
    await database
      .update(invitationMailClaim)
      .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(invitationMailClaim.email, email));
    // The database failing at the renewal, after the mail is claimed.
    const failing = new Proxy(database, {
      get: (target, property) =>
        property === "update"
          ? () => {
              throw new Error("connection lost");
            }
          : Reflect.get(target, property),
    });

    await expect(
      resendInvitation({
        database: failing,
        organizationId,
        actingAs: admin.id,
        invitationId: id,
        create: async () => {
          throw new Error("not asked");
        },
        sendMail: outbox.sendMail,
        baseUrl,
        locale: "en",
        invitationDays: 7,
        now: new Date(),
      }),
    ).rejects.toThrow("connection lost");

    expect(await mailsTo(email)).toBe(1);
  });

  test("mails at most 300 invitations an hour for an organization", async () => {
    await mailedBefore(
      Array.from({ length: 299 }, (_, index) => ({
        email: `hourly-${index}-${crypto.randomUUID()}@example.com`,
        minutesAgo: 1 + (index % 50),
      })),
    );
    // An hour ago no longer counts.
    await mailedBefore([{ email: newEmail(), minutesAgo: 61 }]);
    const results = await resultsOf(
      await invite(admin, { emails: [newEmail(), newEmail()], role: "author" }),
    );

    // Addresses run a few at a time: either may take the last mail.
    expect(
      results
        .map(({ outcome, code }) => `${outcome} ${code ?? ""}`.trim())
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["invited", "refused ORGANIZATION_HOURLY_LIMIT"]);
    const refused = results.find(({ outcome }) => outcome === "refused")!.email;
    expect(outbox.sent.some((sent) => sent.to === refused)).toBe(false);
    expect(await mailsTo(refused)).toBe(0);
  });

  test("refuses Better Auth's organization update, even to an owner", async () => {
    const updated = await request("POST", "/api/auth/organization/update", cookieOf(owner), {
      organizationId,
      data: { name: "Renamed Behind Braivo" },
    });

    expect(updated.status).toBe(404);
  });
});
