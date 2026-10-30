// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The group routes (`groups.ts`), and what teaching a group lets a teacher read
// through the progress routes; with the member list, what access-45 keeps from
// a tool. Which host admits each route is `policy.test.ts`'s table; the rules
// are `application/groups.test.ts`'s.

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createCourse, createObjectives } from "../persistence/index.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";
import type { Group } from "./types.ts";

const { database, api, signUp } = createTestApi();

const organizationId = "groups-api-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let admin!: Signed;
let teacher!: Signed;
let ana!: Signed;
let ben!: Signed;
let courseId!: string;

function send(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  return api.request(path, {
    method,
    headers: { cookie, origin: baseUrl, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const groupsPath = `/api/organizations/${organizationId}/groups`;

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("group routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    [admin, teacher, ana, ben] = await Promise.all([signUp(), signUp(), signUp(), signUp()]);
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [teacher.id, ana.id, ben.id],
      adminIds: [admin.id],
      at,
    });
    const [greetings] = (await createObjectives(database, organizationId, ["Greetings"])) as [
      string,
    ];
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Spanish",
        objectiveIds: [greetings],
      })
    ).id;
  });

  test("lets an administrator set up a class whose teacher reads its learners alone", async () => {
    const created = await send("POST", groupsPath, admin.cookie, {
      name: "7A",
      learnerIds: [ana.id],
      teacherIds: [teacher.id],
      courseIds: [courseId],
    });
    expect(created.status).toBe(201);
    const { groupId } = (await created.json()) as { groupId: string };

    const taught = await send("GET", groupsPath, teacher.cookie);
    expect(taught.status).toBe(200);
    expect(taught.headers.get("cache-control")).toBe("private, no-store");
    expect(await taught.json()).toEqual({
      groups: [
        {
          id: groupId,
          organizationId,
          name: "7A",
          learners: [{ userId: ana.id, name: ana.name }],
          teachers: [{ userId: teacher.id, name: teacher.name }],
          courses: [
            { id: courseId, number: expect.any(Number), title: "Spanish", urlLabel: "spanish" },
          ],
        },
      ] satisfies Group[],
    });

    const overview = await send("GET", `/api/courses/${courseId}/progress`, teacher.cookie);
    expect(overview.status).toBe(200);
    const { learners } = (await overview.json()) as { learners: { userId: string }[] };
    expect(learners.map(({ userId }) => userId)).toEqual([ana.id]);

    const progressOf = (learner: Signed) =>
      send("GET", `/api/courses/${courseId}/learners/${learner.id}/progress`, teacher.cookie);
    expect((await progressOf(ana)).status).toBe(200);
    // Ben is a member, but not in a group this teacher teaches.
    expect((await progressOf(ben)).status).toBe(404);

    // Teaching is not administering.
    expect((await send("GET", groupsPath, ben.cookie)).status).toBe(200);
    expect(
      (await send("POST", `${groupsPath}/${groupId}`, teacher.cookie, { name: "Mine" })).status,
    ).toBe(403);
    expect(
      (await send("GET", `/api/organizations/${organizationId}/members`, teacher.cookie)).status,
    ).toBe(403);
  });

  test("changes a group by what a change names, and finds no group it does not have", async () => {
    const created = await send("POST", groupsPath, admin.cookie, {
      name: "8B",
      learnerIds: [],
      teacherIds: [teacher.id],
      courseIds: [courseId],
    });
    const { groupId } = (await created.json()) as { groupId: string };
    const change = (body: unknown, id = groupId) =>
      send("POST", `${groupsPath}/${id}`, admin.cookie, body);

    const changed = await change({ name: "8B, spring", add: { learnerIds: [ben.id] } });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      group: { id: groupId, name: "8B, spring", learners: [{ userId: ben.id }] },
    });

    // Never a silent promotion: a role changes when the change says so.
    const promoting = await change({ add: { teacherIds: [ben.id] } });
    expect(promoting.status).toBe(409);
    expect(await promoting.json()).toEqual({ error: expect.stringContaining("already a learner") });

    expect((await change({ name: "8B" }, "no-such-group")).status).toBe(404);
    // A misspelt field would otherwise change nothing, unnoticed.
    expect((await change({ add: { learnerId: [ana.id] } })).status).toBe(400);
    expect((await change({ remove: { userIds: "all" } })).status).toBe(400);
    expect((await change({ add: null })).status).toBe(400);
  });

  test("says what is wrong with a group it refuses, and answers a malformed one bare", async () => {
    const refused = await send("POST", groupsPath, admin.cookie, {
      name: "7C",
      learnerIds: [ana.id],
      teacherIds: [ana.id],
      courseIds: [],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: expect.stringContaining("a learner and a teacher"),
    });

    const malformed = await send("POST", groupsPath, admin.cookie, { name: "7C", learnerIds: [] });
    expect([malformed.status, await malformed.text()]).toEqual([400, ""]);
  });

  describe("tool access to members and groups (access-45)", () => {
    /** The owner's; on or off by each test. */
    const firstId = "groups-api-tools-org";
    /** Where the owner is an admin; off unless a test turns it on. */
    const secondId = "groups-api-tools-second-org";
    let owner!: Signed;
    let firstGroupId!: string;
    let secondGroupId!: string;

    const bearer = (signed: Signed) => ({ authorization: `Bearer ${signed.token}` });
    const cookieOf = (signed: Signed) => ({ cookie: signed.cookie, origin: baseUrl });
    const request = (
      method: "GET" | "POST",
      path: string,
      headers: Record<string, string>,
      body?: unknown,
    ) =>
      api.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const membersOf = (organization: string, headers: Record<string, string>) =>
      request("GET", `/api/organizations/${organization}/members`, headers);
    const groupsOf = (organization: string, headers: Record<string, string>) =>
      request("GET", `/api/organizations/${organization}/groups`, headers);
    const changeIn = (
      organization: string,
      groupId: string,
      headers: Record<string, string>,
      change: unknown,
    ) => request("POST", `/api/organizations/${organization}/groups/${groupId}`, headers, change);
    /** The group as the console reads it, whatever the setting. */
    const stored = async (organization: string, groupId: string) => {
      const { groups } = (await (await groupsOf(organization, cookieOf(owner))).json()) as {
        groups: Group[];
      };
      return groups.find(({ id }) => id === groupId);
    };

    beforeAll(async () => {
      owner = await signUp();
      await testing.seedOrganization(database, {
        organizationId: firstId,
        learnerIds: [teacher.id, ana.id, ben.id],
        adminIds: [owner.id],
        at,
      });
      await database
        .update(member)
        .set({ role: "owner" })
        .where(and(eq(member.organizationId, firstId), eq(member.userId, owner.id)));
      await testing.seedOrganization(database, {
        organizationId: secondId,
        learnerIds: [ana.id],
        adminIds: [owner.id],
        at,
      });
      const define = async (organization: string, body: unknown) => {
        const created = await request(
          "POST",
          `/api/organizations/${organization}/groups`,
          cookieOf(owner),
          body,
        );
        return ((await created.json()) as { groupId: string }).groupId;
      };
      firstGroupId = await define(firstId, {
        name: "7A",
        learnerIds: [ana.id],
        teacherIds: [teacher.id],
        courseIds: [],
      });
      secondGroupId = await define(secondId, {
        name: "8B",
        learnerIds: [ana.id],
        teacherIds: [],
        courseIds: [],
      });
    });

    beforeEach(async () => {
      await testing.setToolsReadLearnerData(database, firstId, false);
      await testing.setToolsReadLearnerData(database, secondId, false);
      // Names back as created, so a test that renames leaves no trace in the next.
      for (const [organization, groupId, name] of [
        [firstId, firstGroupId, "7A"],
        [secondId, secondGroupId, "8B"],
      ] as const) {
        expect((await changeIn(organization, groupId, cookieOf(owner), { name })).status).toBe(200);
      }
    });

    test("refuses an owner's and a teacher's token while off, leaving the group unchanged", async () => {
      expect((await membersOf(firstId, bearer(owner))).status).toBe(403);
      expect((await groupsOf(firstId, bearer(owner))).status).toBe(403);
      expect((await groupsOf(firstId, bearer(teacher))).status).toBe(403);
      expect((await changeIn(firstId, firstGroupId, bearer(owner), { name: "Mine" })).status).toBe(
        403,
      );
      expect((await stored(firstId, firstGroupId))?.name).toBe("7A");
    });

    test("answers the same tokens as the console once on", async () => {
      await testing.setToolsReadLearnerData(database, firstId, true);

      for (const [read, signed] of [
        [membersOf, owner],
        [groupsOf, owner],
        [groupsOf, teacher],
      ] as const) {
        const asTool = await read(firstId, bearer(signed));
        expect(asTool.status).toBe(200);
        expect(await asTool.json()).toEqual(await (await read(firstId, cookieOf(signed))).json());
      }
      const changed = await changeIn(firstId, firstGroupId, bearer(owner), { name: "7A, tool" });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ group: await stored(firstId, firstGroupId) });
    });

    test("widens nothing once on: a teacher's token stays refused what administering takes", async () => {
      await testing.setToolsReadLearnerData(database, firstId, true);

      expect((await membersOf(firstId, bearer(teacher))).status).toBe(403);
      expect(
        (await changeIn(firstId, firstGroupId, bearer(teacher), { name: "Mine" })).status,
      ).toBe(403);
      expect((await groupsOf(secondId, bearer(teacher))).status).toBe(403);
      expect((await stored(firstId, firstGroupId))?.name).toBe("7A");
    });

    test("lets the console read and change either way", async () => {
      for (const allowed of [false, true]) {
        await testing.setToolsReadLearnerData(database, firstId, allowed);
        expect((await membersOf(firstId, cookieOf(owner))).status).toBe(200);
        expect((await groupsOf(firstId, cookieOf(owner))).status).toBe(200);
        expect((await groupsOf(firstId, cookieOf(teacher))).status).toBe(200);
        expect(
          (await changeIn(firstId, firstGroupId, cookieOf(owner), { name: "7A" })).status,
        ).toBe(200);
      }
    });

    test("refuses a browser's cookie carrying a token's Authorization, as a tool", async () => {
      const both = { ...cookieOf(owner), ...bearer(owner) };

      expect((await membersOf(firstId, both)).status).toBe(403);
      expect((await groupsOf(firstId, both)).status).toBe(403);
      expect((await changeIn(firstId, firstGroupId, both, { name: "Mine" })).status).toBe(403);
      expect((await stored(firstId, firstGroupId))?.name).toBe("7A");
    });

    test("lets a token create a group while off: its answer is only the ID", async () => {
      const created = await request("POST", `/api/organizations/${firstId}/groups`, bearer(owner), {
        name: "Created by a tool",
        learnerIds: [ben.id],
        teacherIds: [],
        courseIds: [],
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ groupId: expect.any(String) });
    });

    test("answers a token's change 403 while off before what reads people or groups, 400 or 404 once on", async () => {
      const addingStranger = { add: { learnerIds: [crypto.randomUUID()] } };
      expect((await changeIn(firstId, firstGroupId, bearer(owner), addingStranger)).status).toBe(
        403,
      );
      expect(
        (await changeIn(firstId, "no-such-group", bearer(owner), { name: "Any" })).status,
      ).toBe(403);
      // What reads nothing is refused as before: a malformed body, a change naming nothing.
      expect((await changeIn(firstId, firstGroupId, bearer(owner), { add: null })).status).toBe(
        400,
      );
      expect((await changeIn(firstId, firstGroupId, bearer(owner), {})).status).toBe(400);

      await testing.setToolsReadLearnerData(database, firstId, true);
      expect((await changeIn(firstId, firstGroupId, bearer(owner), addingStranger)).status).toBe(
        400,
      );
      expect(
        (await changeIn(firstId, "no-such-group", bearer(owner), { name: "Any" })).status,
      ).toBe(404);
      expect((await stored(firstId, firstGroupId))?.learners).toEqual([
        { userId: ana.id, name: ana.name },
      ]);
    });

    test("answers one admin's token by each organization's own setting, and refuses its next request once off", async () => {
      await testing.setToolsReadLearnerData(database, firstId, true);

      expect((await membersOf(firstId, bearer(owner))).status).toBe(200);
      expect((await groupsOf(firstId, bearer(owner))).status).toBe(200);
      expect(
        (await changeIn(firstId, firstGroupId, bearer(owner), { name: "7A, allowed" })).status,
      ).toBe(200);
      expect((await membersOf(secondId, bearer(owner))).status).toBe(403);
      expect((await groupsOf(secondId, bearer(owner))).status).toBe(403);
      expect(
        (await changeIn(secondId, secondGroupId, bearer(owner), { name: "Mine" })).status,
      ).toBe(403);
      // Each organization's group under the other's URL changes neither.
      expect((await changeIn(firstId, secondGroupId, bearer(owner), { name: "Mine" })).status).toBe(
        404,
      );
      expect((await changeIn(secondId, firstGroupId, bearer(owner), { name: "Mine" })).status).toBe(
        403,
      );
      expect((await stored(firstId, firstGroupId))?.name).toBe("7A, allowed");
      expect((await stored(secondId, secondGroupId))?.name).toBe("8B");

      await testing.setToolsReadLearnerData(database, firstId, false);

      // Each use case reads the setting again: none keeps what it read before.
      expect((await membersOf(firstId, bearer(owner))).status).toBe(403);
      expect((await groupsOf(firstId, bearer(owner))).status).toBe(403);
      expect((await changeIn(firstId, firstGroupId, bearer(owner), { name: "Mine" })).status).toBe(
        403,
      );
      expect((await stored(firstId, firstGroupId))?.name).toBe("7A, allowed");
    });
  });
});
