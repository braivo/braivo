// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Removing a member and giving or taking roles, over HTTP (access-56): who may,
// whom they may not (an owner, themselves), and what removal keeps (learning
// history) and drops (groups), with an invitation outliving its inviter.

import { runMigrations } from "@braivo/db";
import {
  attempt,
  groupMember,
  invitation,
  learnerEvidence,
  member,
  objective,
  task,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createObjectives, makeMemberOwner } from "../persistence/index.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, signUp, signUpAs } = createTestApi();

const organizationId = "members-api-org";
const membersPath = `/api/organizations/${organizationId}/members`;
const invitationsPath = `/api/organizations/${organizationId}/invitations`;
const at = new Date("2026-06-01T00:00:00.000Z");

let owner!: Signed;
let admin!: Signed;
let secondAdmin!: Signed;
let author!: Signed;
let learner!: Signed;

const cookieOf = (signed: Signed) => ({ cookie: signed.cookie, origin: baseUrl });
const post = (url: string, headers: Record<string, string>, body?: unknown) =>
  api.request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const remove = (by: Signed, userId: string, headers: Record<string, string> = cookieOf(by)) =>
  post(`${membersPath}/${userId}/remove`, headers);
const setRole = (
  by: Signed,
  userId: string,
  role: unknown,
  headers: Record<string, string> = cookieOf(by),
) => post(`${membersPath}/${userId}/role`, headers, { role });

const rolesOf = async (userId: string) =>
  (
    await database
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
  ).map(({ role }) => role);

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("members, over HTTP", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    [owner, admin, secondAdmin, author] = await Promise.all([
      signUp(),
      signUp(),
      signUp(),
      signUp(),
    ]);
  });

  beforeEach(async () => {
    // A learner of its own each test: removal is what is tested.
    learner = await signUp();
    await database.delete(invitation).where(eq(invitation.organizationId, organizationId));
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [author.id, learner.id],
      adminIds: [owner.id, admin.id, secondAdmin.id],
      at,
    });
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

  test("removing a member keeps their learning history and drops their groups", async () => {
    const [objectiveId] = (await createObjectives(database, organizationId, ["Kept"])) as [string];
    const taskId = await testing.createTask(database, {
      organizationId,
      objectiveId,
      body: { kind: "typed", prompt: "Ich ___ müde.", accepted: ["bin"] },
      createdAt: at,
    });
    await database
      .insert(attempt)
      .values({ id: "kept", learnerId: learner.id, organizationId, taskId, response: {}, at });
    await database.insert(learnerEvidence).values({
      id: "kept",
      learnerId: learner.id,
      organizationId,
      objectiveId,
      outcome: "success",
      at,
    });
    const group = await post(`/api/organizations/${organizationId}/groups`, cookieOf(admin), {
      name: "7A",
      learnerIds: [learner.id],
      teacherIds: [author.id],
      courseIds: [],
    });
    expect(group.status).toBe(201);

    const removed = await remove(admin, learner.id);

    expect(removed.status).toBe(204);
    expect(await rolesOf(learner.id)).toEqual([]);
    const groupsLeft = await database
      .select()
      .from(groupMember)
      .where(eq(groupMember.userId, learner.id));
    expect(groupsLeft).toEqual([]);
    // The teacher stays in the group.
    expect(
      await database.select().from(groupMember).where(eq(groupMember.userId, author.id)),
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: attempt.id })
        .from(attempt)
        .where(eq(attempt.learnerId, learner.id)),
    ).toEqual([{ id: "kept" }]);
    expect(await testing.readStoredEvidence(database, learner.id)).toHaveLength(1);
    // Removed, they reach nothing there.
    const listing = await api.request(`/api/organizations/${organizationId}/courses`, {
      headers: { cookie: learner.cookie },
    });
    expect(listing.status).toBe(403);
    expect((await remove(admin, learner.id)).status).toBe(404);

    await database.delete(attempt).where(eq(attempt.learnerId, learner.id));
    await database.delete(learnerEvidence).where(eq(learnerEvidence.learnerId, learner.id));
    await database.delete(task).where(eq(task.id, taskId));
    await database.delete(objective).where(eq(objective.id, objectiveId));
  });

  test("gives and takes roles, setting exactly the one chosen", async () => {
    const authored = await setRole(admin, learner.id, "author");
    expect(authored.status).toBe(200);
    expect(await authored.json()).toEqual({
      member: { userId: learner.id, name: learner.name, roles: ["author"] },
    });
    expect(await rolesOf(learner.id)).toEqual(["author"]);

    expect((await setRole(owner, learner.id, "admin")).status).toBe(200);
    expect(await rolesOf(learner.id)).toEqual(["admin"]);

    // Taken back: a learner again, their membership whole.
    expect((await setRole(admin, learner.id, "member")).status).toBe(200);
    expect(await rolesOf(learner.id)).toEqual(["member"]);

    // Several roles held become the one chosen.
    await database
      .update(member)
      .set({ role: "member,author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, learner.id)));
    expect((await setRole(admin, learner.id, "admin")).status).toBe(200);
    expect(await rolesOf(learner.id)).toEqual(["admin"]);
  });

  test("refuses an owner's role or removal to anyone, and acting on oneself", async () => {
    for (const [by, refused] of [
      [admin, await setRole(admin, owner.id, "member")],
      [admin, await remove(admin, owner.id)],
      [owner, await setRole(owner, owner.id, "admin")],
      [owner, await remove(owner, owner.id)],
    ] as const) {
      expect(refused.status, by.name).toBe(409);
    }
    expect(await (await remove(admin, owner.id)).json()).toMatchObject({ code: "MEMBER_IS_OWNER" });
    // An owner among other roles is still an owner.
    await database
      .update(member)
      .set({ role: "member,owner" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, secondAdmin.id)));
    expect(await (await setRole(admin, secondAdmin.id, "member")).json()).toMatchObject({
      code: "MEMBER_IS_OWNER",
    });
    expect(await rolesOf(secondAdmin.id)).toEqual(["member,owner"]);

    const self = await remove(admin, admin.id);
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: "OWN_MEMBERSHIP" });
    expect(await (await setRole(admin, admin.id, "member")).json()).toMatchObject({
      code: "OWN_MEMBERSHIP",
    });
    expect(await rolesOf(owner.id)).toEqual(["owner"]);
    expect(await rolesOf(admin.id)).toEqual(["admin"]);
  });

  test("refuses a role not offered, and someone not a member", async () => {
    for (const role of ["owner", "teacher", "", 1, undefined, ["admin"]]) {
      const refused = await setRole(admin, learner.id, role);
      expect(refused.status, String(role)).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "ROLE_NOT_ASSIGNABLE" });
    }
    expect(await rolesOf(learner.id)).toEqual(["member"]);
    const stranger = await signUp();
    const notMember = await setRole(admin, stranger.id, "author");
    expect(notMember.status).toBe(404);
    expect(await notMember.json()).toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect((await remove(admin, stranger.id)).status).toBe(404);
    expect(await rolesOf(stranger.id)).toEqual([]);
  });

  test("lets only an owner or admin, in a browser, change members", async () => {
    for (const by of [author, learner]) {
      expect((await remove(by, admin.id)).status).toBe(403);
      expect((await setRole(by, learner.id, "admin")).status).toBe(403);
    }
    const stranger = await signUp();
    expect((await remove(stranger, learner.id)).status).toBe(403);
    const token = { authorization: `Bearer ${owner.token}` };
    expect((await remove(owner, learner.id, token)).status).toBe(403);
    expect((await setRole(owner, learner.id, "admin", token)).status).toBe(403);
    // A foreign origin writes nothing (access-28).
    const foreign = { cookie: owner.cookie, origin: "https://elsewhere.example" };
    expect((await remove(owner, learner.id, foreign)).status).toBe(403);
    expect(await rolesOf(learner.id)).toEqual(["member"]);
    expect(await rolesOf(admin.id)).toEqual(["admin"]);
    // Better Auth's own stay closed (access-26).
    for (const path of ["remove-member", "update-member-role"]) {
      const closed = await post(`/api/auth/organization/${path}`, cookieOf(owner), {
        organizationId,
        memberIdOrEmail: learner.email,
        memberId: `${organizationId}:${learner.id}`,
        role: "admin",
      });
      expect(closed.status, path).toBe(404);
    }
  });

  test("made owner, a member's session has the authority at once, signing in again for nothing", async () => {
    const listing = () => api.request(membersPath, { headers: { cookie: learner.cookie } });
    expect((await listing()).status).toBe(403);
    await makeMemberOwner(database, { organizationId, userId: learner.id });
    expect((await listing()).status).toBe(200);
  });

  test("a member cannot leave by themselves: an administrator or the operator ends it", async () => {
    const left = await post("/api/auth/organization/leave", cookieOf(learner), { organizationId });
    expect(left.status).toBe(404);
    expect(await rolesOf(learner.id)).toEqual(["member"]);
  });

  test("an invitation outlives its inviter's removal: listed, cancelled, or accepted", async () => {
    const invite = async (email: string) => {
      const answered = await post(invitationsPath, cookieOf(secondAdmin), {
        emails: [email],
        role: "author",
      });
      expect(answered.status).toBe(200);
      return ((await answered.json()) as { results: [{ invitation: { id: string } }] }).results[0]
        .invitation.id;
    };
    const kept = `kept-${crypto.randomUUID()}@example.com`;
    const cancelled = `cancelled-${crypto.randomUUID()}@example.com`;
    const keptId = await invite(kept);
    const cancelledId = await invite(cancelled);

    expect((await remove(owner, secondAdmin.id)).status).toBe(204);

    const listed = await api.request(invitationsPath, { headers: { cookie: owner.cookie } });
    expect(
      ((await listed.json()) as { invitations: { id: string }[] }).invitations.map(({ id }) => id),
    ).toEqual(expect.arrayContaining([keptId, cancelledId]));
    expect((await post(`${invitationsPath}/${cancelledId}/cancel`, cookieOf(admin))).status).toBe(
      200,
    );
    const recipient = await signUpAs(kept, "Ada Kept");
    const accepted = await post("/api/auth/organization/accept-invitation", cookieOf(recipient), {
      invitationId: keptId,
    });
    expect(accepted.status).toBe(200);
    expect(await rolesOf(recipient.id)).toEqual(["author"]);
  });
  test("an accepted link goes on as its recipient is now, not as invited (access-52)", async () => {
    const email = `changed-${crypto.randomUUID()}@example.com`;
    const answered = await post(invitationsPath, cookieOf(admin), {
      emails: [email],
      role: "author",
    });
    const id = ((await answered.json()) as { results: [{ invitation: { id: string } }] }).results[0]
      .invitation.id;
    const recipient = await signUpAs(email, "Ada Changed");
    const accepted = await post("/api/auth/organization/accept-invitation", cookieOf(recipient), {
      invitationId: id,
    });
    expect(accepted.status).toBe(200);
    const page = async (by = recipient) =>
      (await api.request(`/api/invitations/${id}`, { headers: cookieOf(by) })).json();

    expect(await page()).toMatchObject({
      status: "accepted",
      role: "author",
      continueTo: "console",
    });
    expect(await page()).not.toHaveProperty("learnDomain");

    // Made a learner: the learn domain, though invited to author; none here yet.
    expect((await setRole(owner, recipient.id, "member")).status).toBe(200);
    expect(await page()).toMatchObject({ role: "author", continueTo: "learn", learnDomain: null });

    // Removed: nowhere, and nothing says they stay a member.
    expect((await remove(owner, recipient.id)).status).toBe(204);
    const removed = await page();
    expect(removed).toMatchObject({ status: "accepted", member: false });
    expect(removed).not.toHaveProperty("continueTo");
    expect(removed).not.toHaveProperty("learnDomain");
    expect(await page(learner)).not.toHaveProperty("continueTo");
  });
});
