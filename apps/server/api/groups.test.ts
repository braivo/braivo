// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The group routes (`groups.ts`), and what teaching a group lets a teacher read
// through the progress routes. Which host admits each route is
// `policy.test.ts`'s table; the rules are `application/groups.test.ts`'s.

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

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
    courseId = await createCourse(database, {
      organizationId,
      title: "Spanish",
      objectiveIds: [greetings],
    });
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
          courses: [{ id: courseId, title: "Spanish" }],
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
});
