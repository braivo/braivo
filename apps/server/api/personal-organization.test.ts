// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A personal organization is one account's, alone (ADR 0060): whose it is is
// `personal_owner_id`, and no writer, Braivo's or Better Auth's, lets anyone
// else join it, nor anyone be invited to it.

import { runMigrations, type Transaction } from "@braivo/db";
import { invitation, member, organization } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import {
  eraseLearnerHistory,
  previewHistoryErasure,
  previewOwnerPromotion,
} from "../application/index.ts";
import { addMember } from "../auth/index.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, auth, signUp } = createTestApi({
  selfServeDomain: "personal-organization-test.example",
});
const at = new Date("2026-06-01T00:00:00.000Z");
const DAY = 86_400_000;

const post = (path: string, cookie: string, body: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: baseUrl },
    body: JSON.stringify(body),
  });

/** The account's personal organization, set up as a person would. */
async function personalOf(person: Signed): Promise<{ id: string; slug: string }> {
  const response = await post("/api/organization-setup", person.cookie, { personal: true });
  expect(response.status).toBe(201);
  return ((await response.json()) as { organization: { id: string; slug: string } }).organization;
}

async function publishedCourse(organizationId: string, title: string): Promise<string> {
  const [objective] = await createObjectives(database, organizationId, [title]);
  const created = await createCourse(database, {
    published: true,
    organizationId,
    title,
    objectiveIds: [objective!],
  });
  return created.id;
}

const personalCourses = async (person: Signed) => {
  const response = await api.request("/api/courses?personal=true", {
    headers: { cookie: person.cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { courses: { id: string }[] }).courses.map(({ id }) => id);
};

/** The database's refusal, whichever statement met it. */
const refusedByDatabase = (write: Promise<unknown>) =>
  expect(write).rejects.toMatchObject({ cause: { code: "23514" } });

/**
 * Writes a row the trigger refuses, with it switched off for this transaction
 * alone: the state a writer slipping past it, or one predating it, would leave.
 */
function bypassing(
  table: "member" | "invitation",
  write: (transaction: Transaction) => Promise<unknown>,
) {
  const trigger =
    table === "member"
      ? "member_personal_organization_owner_only"
      : "invitation_personal_organization_none";
  return database.transaction(async (transaction) => {
    await transaction.execute(sql.raw(`alter table "${table}" disable trigger "${trigger}"`));
    await write(transaction);
    await transaction.execute(sql.raw(`alter table "${table}" enable trigger "${trigger}"`));
  });
}

const membersOf = (organizationId: string) =>
  database
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId));

describe.skipIf(!connectionString)("a personal organization, its owner's alone (ADR 0060)", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  test("the database refuses anyone else's membership and any invitation, whoever writes it", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);

    await refusedByDatabase(
      database.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: own.id,
        userId: bob.id,
        role: "admin",
        createdAt: at,
      }),
    );
    // Nor is the owner's own row moved to someone else.
    await refusedByDatabase(
      database
        .update(member)
        .set({ userId: bob.id })
        .where(and(eq(member.organizationId, own.id), eq(member.userId, alice.id))),
    );
    await refusedByDatabase(
      database.insert(invitation).values({
        id: crypto.randomUUID(),
        organizationId: own.id,
        email: bob.email,
        role: "admin",
        status: "pending",
        expiresAt: new Date(Date.now() + DAY),
        createdAt: at,
        inviterId: alice.id,
      }),
    );
    expect(await membersOf(own.id)).toEqual([{ userId: alice.id, role: "owner" }]);

    // An ordinary organization takes them as before.
    const school = `personal-test-school-${crypto.randomUUID()}`;
    await testing.seedOrganization(database, { organizationId: school, learnerIds: [], at });
    await database.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: school,
      userId: bob.id,
      role: "admin",
      createdAt: at,
    });
    expect(await membersOf(school)).toEqual([{ userId: bob.id, role: "admin" }]);
    // Nor is a membership elsewhere moved into it.
    await refusedByDatabase(
      database
        .update(member)
        .set({ organizationId: own.id })
        .where(eq(member.organizationId, school)),
    );
    expect(await membersOf(school)).toEqual([{ userId: bob.id, role: "admin" }]);
  });

  test("its owner invites no one, in any role, and is told why; Better Auth's own call too", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);
    const aliceCourse = await publishedCourse(own.id, "Alice's Greek");

    for (const role of ["admin", "author", "member"]) {
      const invited = await post(`/api/organizations/${own.id}/invitations`, alice.cookie, {
        emails: [bob.email],
        role,
      });
      expect(invited.status, role).toBe(409);
      expect(await invited.json()).toMatchObject({ code: "PERSONAL_ORGANIZATION" });
    }
    await expect(
      auth.api.createInvitation({
        headers: new Headers({ cookie: alice.cookie }),
        body: { organizationId: own.id, email: bob.email, role: "admin" },
      }),
    ).rejects.toMatchObject({ body: { code: "PERSONAL_ORGANIZATION" } });
    expect(await database.$count(invitation, eq(invitation.organizationId, own.id))).toBe(0);

    // What was reproduced: Bob, invited as an admin, listed Alice's course as his own.
    expect(await personalCourses(bob)).toEqual([]);
    expect(await personalCourses(alice)).toEqual([aliceCourse]);
  });

  test("an invitation stored before cannot be accepted, and stays pending", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);
    const id = crypto.randomUUID();
    await bypassing("invitation", (transaction) =>
      transaction.insert(invitation).values({
        id,
        organizationId: own.id,
        email: bob.email,
        role: "admin",
        status: "pending",
        expiresAt: new Date(Date.now() + DAY),
        createdAt: at,
        inviterId: alice.id,
      }),
    );

    const accepted = await post("/api/auth/organization/accept-invitation", bob.cookie, {
      invitationId: id,
    });
    expect(accepted.status).toBe(403);
    expect(await accepted.json()).toMatchObject({ code: "PERSONAL_ORGANIZATION" });
    const [kept] = await database
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id));
    expect(kept).toEqual({ status: "pending" });
    expect(await membersOf(own.id)).toEqual([{ userId: alice.id, role: "owner" }]);
  });

  test("the operator's add-member refuses it in words, a learner included", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);
    for (const role of ["member", "author", "admin"]) {
      await expect(addMember(auth, { slug: own.slug, email: bob.email, role })).rejects.toThrow(
        "is a personal organization, its owner's alone: no one else joins it.",
      );
    }
    expect(await membersOf(own.id)).toEqual([{ userId: alice.id, role: "owner" }]);
  });

  test("the operator's make-owner refuses it, so no one comes to hold two", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);
    await personalOf(bob);
    await expect(
      previewOwnerPromotion({ database, slug: own.slug, email: alice.email }),
    ).rejects.toThrow("is a personal organization, its owner's alone: it takes no other owner.");
    await expect(
      previewOwnerPromotion({ database, slug: own.slug, email: bob.email }),
    ).rejects.toThrow("is a personal organization");
    // Bob's is his one: whose it is never moves.
    const owned = await database
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.personalOwnerId, bob.id));
    expect(owned).toHaveLength(1);
  });

  test("its owner's membership is not ended by erasing their history there", async () => {
    const alice = await signUp();
    const own = await personalOf(alice);
    await publishedCourse(own.id, "Alice's Latin");
    const { target } = await previewHistoryErasure({
      database,
      email: alice.email,
      organizationSlug: own.slug,
    });
    const log = {
      hmacKey: "personal-organization-test-key-long-enough",
      store: { put: async () => {} },
    };
    await expect(
      eraseLearnerHistory({ database, target, endMembership: true, log }),
    ).rejects.toThrow("is the only owner of");
    expect(await membersOf(own.id)).toEqual([{ userId: alice.id, role: "owner" }]);
  });

  test("a stray membership row changes no one's My learning, nor whose it is", async () => {
    const [alice, bob] = [await signUp(), await signUp()];
    const own = await personalOf(alice);
    const aliceCourse = await publishedCourse(own.id, "Alice's Greek");
    await bypassing("member", (transaction) =>
      transaction.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: own.id,
        userId: bob.id,
        role: "owner",
        createdAt: at,
      }),
    );

    expect(await personalCourses(bob)).toEqual([]);
    expect(await personalCourses(alice)).toEqual([aliceCourse]);
    // Setting his up makes Bob his own, not Alice's answered back.
    const bobs = await personalOf(bob);
    expect(bobs.id).not.toBe(own.id);
  });
});
