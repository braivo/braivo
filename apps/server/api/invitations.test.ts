// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Inviting an author or administrator, over HTTP (ADR 0018, access-27, 50 to
// 54): who invites whom, the mail and its failure, who lists invitations, what
// the page reads with and without a session, and who accepts.

import { runMigrations } from "@braivo/db";
import { invitation, member, organization, user } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, outbox, signUp, signUpAs } = createTestApi();

const organizationId = "invitations-api-org";
const invitationsPath = `/api/organizations/${organizationId}/invitations`;
const at = new Date("2026-06-01T00:00:00.000Z");
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

/** Invites `email` as `role` by the admin, answering the invitation's ID. */
async function invited(email: string, role = "author"): Promise<string> {
  const answered = await invite(admin, { email, role });
  expect(answered.status).toBe(201);
  return ((await answered.json()) as { invitation: { id: string } }).invitation.id;
}

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
    outbox.failTo.clear();
  });

  test("an owner or admin invites an author or administrator for 7 days, and mails them", async () => {
    const email = newEmail();
    const before = Date.now();

    const answered = await invite(owner, { email: `  ${email.toUpperCase()} `, role: "author" });

    expect(answered.status).toBe(201);
    const body = (await answered.json()) as {
      invitation: { id: string; email: string; role: string; expiresAt: string };
      emailSent: boolean;
    };
    expect(body).toMatchObject({ invitation: { email, role: "author" }, emailSent: true });
    const expiresAt = Date.parse(body.invitation.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    const mail = outbox.sent.findLast((sent) => sent.to === email);
    // The school, the inviter, the role in plain words, and the link.
    expect(mail?.subject).toContain(organizationId);
    expect(mail?.text).toContain(owner.name);
    expect(mail?.text).toContain(`${baseUrl}/invitations/${body.invitation.id}`);
    expect(mail?.text).toMatch(/manage and publish/i);
    expect((await invite(admin, { email: newEmail(), role: "admin" })).status).toBe(201);
  });

  test("mails in the inviter's language", async () => {
    const email = newEmail();

    await invite(admin, { email, role: "admin" }, { "accept-language": "pl-PL,pl;q=0.9" });

    expect(outbox.sent.findLast((sent) => sent.to === email)?.subject).toMatch(/zaprasza/);
  });

  test("refuses an owner invitation, and roles not offered", async () => {
    for (const role of ["owner", "member", "teacher", ["author", "admin"], "author,admin"]) {
      const answered = await invite(owner, { email: newEmail(), role });

      expect(answered.status).toBe(400);
      expect(await answered.json()).toMatchObject({ code: "ROLE_NOT_INVITABLE" });
    }
    const malformed = await invite(owner, { email: "not an email", role: "author" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "EMAIL_INVALID" });
    expect(
      await database.select().from(invitation).where(eq(invitation.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("refuses an author, a learner, a stranger, and a tool inviting", async () => {
    const stranger = await signUp();

    for (const signed of [author, learner, stranger]) {
      expect((await invite(signed, { email: newEmail(), role: "author" })).status).toBe(403);
    }
    const token = await request(
      "POST",
      invitationsPath,
      { authorization: `Bearer ${admin.token}` },
      { email: newEmail(), role: "author" },
    );
    expect(token.status).toBe(403);
    expect(
      (await request("POST", invitationsPath, {}, { email: newEmail(), role: "author" })).status,
    ).toBe(401);
    expect(
      await database.select().from(invitation).where(eq(invitation.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("reports an address already a member, or already invited, keeping what is there", async () => {
    const email = newEmail();
    await invited(email, "admin");

    const again = await invite(owner, { email, role: "author" });
    const memberAgain = await invite(owner, { email: author.email, role: "admin" });

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "ALREADY_INVITED", role: "admin" });
    expect(memberAgain.status).toBe(409);
    expect(await memberAgain.json()).toMatchObject({ code: "ALREADY_MEMBER", roles: ["author"] });
    expect(await rolesOf(author.id)).toEqual(["author"]);
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

    expect((await invite(admin, { email: newEmail(), role: "author" })).status).toBe(201);
    const refusedEmail = newEmail();
    const refused = await invite(admin, { email: refusedEmail, role: "author" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PENDING_LIMIT" });
    expect(outbox.sent.some((sent) => sent.to === refusedEmail)).toBe(false);
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

    const again = await invite(owner, { email, role: "author" });

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "ALREADY_INVITED", role: "admin" });
  });

  test("reports an invitation whose mail could not be sent apart from a refusal", async () => {
    const email = newEmail();
    outbox.failTo.add(email);

    const answered = await invite(admin, { email, role: "author" });

    expect(answered.status).toBe(201);
    const { invitation: made, emailSent } = (await answered.json()) as {
      invitation: { id: string };
      emailSent: boolean;
    };
    expect(emailSent).toBe(false);
    // Stored all the same, its link still good to copy.
    expect((await preview(made.id)).status).toBe(200);
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
    expect(await listed.json()).toEqual({
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
    // As two admins inviting at the same moment may both store one.
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

  test("refuses Better Auth's organization update, even to an owner", async () => {
    const updated = await request("POST", "/api/auth/organization/update", cookieOf(owner), {
      organizationId,
      data: { name: "Renamed Behind Braivo" },
    });

    expect(updated.status).toBe(404);
  });
});
