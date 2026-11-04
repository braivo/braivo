// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// `GET /api/organizations/:organizationId/first-answers` (`reports.ts`): who
// reads learners' first answers, and the answer's shape (progress-18). What
// is counted is `application/first-answers.test.ts`'s.

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { createCourse, createGroup, createObjectives } from "../persistence/index.ts";
import { createConnectionRequest } from "./principal.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, signUp } = createTestApi();
const organizationId = "first-answers-api-test-org";
const otherOrganizationId = "first-answers-api-test-other-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let learners!: Signed[];
let admin!: Signed;
let author!: Signed;
let teacher!: Signed;
let objectiveId!: string;
let courseId!: string;
let taskId!: string;
let foreignCourseId!: string;

/** A browser's session cookie, or a tool's token. */
type Credential = { cookie: string } | { token: string };
const headersOf = (credential: Credential): Record<string, string> =>
  "token" in credential
    ? { authorization: `Bearer ${credential.token}` }
    : { cookie: credential.cookie };
const browser = (signed: Signed): Credential => ({ cookie: signed.cookie });

const path = (query: string) => `/api/organizations/${organizationId}/first-answers${query}`;
const readAs = (credential: Credential, query = `?courseId=${courseId}`) =>
  api.request(path(query), { headers: headersOf(credential) });

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the first answers route", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    learners = [];
    for (let index = 0; index < 5; index++) learners.push(await signUp());
    admin = await signUp();
    author = await signUp();
    teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [...learners.map(({ id }) => id), author.id, teacher.id],
      adminIds: [admin.id],
      at,
    });
    await database
      .update(member)
      .set({ role: "author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author.id)));

    [objectiveId] = (await createObjectives(database, organizationId, ["Past tense"])) as [string];
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Spanish",
        objectiveIds: [objectiveId],
      })
    ).id;
    await createGroup(database, {
      organizationId,
      definition: {
        name: "Class",
        learnerIds: [learners[0]!.id],
        teacherIds: [teacher.id],
        courseIds: [courseId],
      },
    });
    taskId = await testing.createTask(database, {
      organizationId,
      objectiveId,
      body: { kind: "choice", prompt: "Past of go?", options: ["went", "goed"], answer: 0 },
      createdAt: at,
    });
    // Answered as learners answer, through the course.
    for (const [index, learner] of learners.entries()) {
      const answered = await api.request(`/api/courses/${courseId}/attempts`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: learner.cookie },
        body: JSON.stringify({
          id: "a1",
          taskId,
          historyEpoch: 0,
          response: { choice: index === 0 ? 1 : 0 },
        }),
      });
      expect(answered.status).toBe(200);
    }

    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      adminIds: [admin.id],
      at,
    });
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourseId = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [theirs!],
      })
    ).id;
  });

  test("answers an administrator's browser, in the documented shape, uncacheable", async () => {
    const response = await readAs(browser(admin));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      minLearners: 5,
      tasks: [
        {
          id: taskId,
          objectiveId,
          first: { learners: 5, correct: 4, incorrect: 1, revealed: 0, options: [4, 1] },
          otherTasks: null,
        },
      ],
      retired: [],
    });
    expect((await readAs(browser(admin), `?objectiveId=${objectiveId}`)).status).toBe(200);
  });

  test("refuses an author, a teacher, and a learner; a tool explained, whatever tools may read", async () => {
    for (const reader of [author, teacher, learners[1]!]) {
      expect((await readAs(browser(reader))).status).toBe(403);
    }
    for (const allowed of [false, true]) {
      await testing.setToolsReadLearnerData(database, organizationId, allowed);
      const read = await readAs({ token: admin.token });
      expect(read.status).toBe(403);
      expect(await read.json()).toEqual({ error: expect.stringContaining("console") });
    }
    await testing.setToolsReadLearnerData(database, organizationId, false);
  });

  test("refuses a connection, whose scope reaches authoring alone (access-41)", async () => {
    const asConnection = await api.fetch(
      createConnectionRequest(
        { userId: admin.id, clientId: "c", scopes: ["braivo:author"], organizationId },
        new URL(path(`?courseId=${courseId}`), baseUrl).href,
      ),
    );
    expect(asConnection.status).toBe(403);
  });

  test("finds no course of another organization under this one", async () => {
    expect((await readAs(browser(admin), `?courseId=${foreignCourseId}`)).status).toBe(404);
    expect((await readAs(browser(admin), "?objectiveId=missing")).status).toBe(404);
  });

  test("refuses a read naming no course or objective, both, or an empty one", async () => {
    for (const query of [
      "",
      `?taskId=${taskId}`,
      `?courseId=${courseId}&objectiveId=${objectiveId}`,
      "?courseId=",
    ]) {
      expect((await readAs(browser(admin), query)).status).toBe(400);
    }
  });
});
