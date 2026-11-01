// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The reports routes (`reports.ts`): an organization's administrators reading
// and dismissing learners' reports of tasks (access-46, ADR 0052). What the
// use case decides is `application/task-report.test.ts`'s; which host admits
// each route is `policy.test.ts`'s.

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { createCourse, createObjectives } from "../persistence/index.ts";
import { connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, signUp } = createTestApi();
const organizationId = "reports-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let learner!: Signed;
let admin!: Signed;
let author!: Signed;
let courseId!: string;
let taskId!: string;

/** A browser's session cookie, or a tool's token. */
type Credential = { cookie: string } | { token: string };
const headersOf = (credential: Credential): Record<string, string> =>
  "token" in credential
    ? { authorization: `Bearer ${credential.token}` }
    : { cookie: credential.cookie };

const reportsOf = (credential: Credential, query = "") =>
  api.request(`/api/organizations/${organizationId}/reports${query}`, {
    headers: headersOf(credential),
  });

const dismiss = (credential: Credential, body: unknown) =>
  api.request(`/api/organizations/${organizationId}/reports/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headersOf(credential) },
    body: JSON.stringify(body),
  });

const browser = (signed: Signed): Credential => ({ cookie: signed.cookie });

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the reports routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    learner = await signUp();
    admin = await signUp();
    author = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id, author.id],
      adminIds: [admin.id],
      at,
    });
    await database
      .update(member)
      .set({ role: "author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author.id)));

    const [objectiveId] = await createObjectives(database, organizationId, ["Past tense"]);
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Spanish",
        objectiveIds: [objectiveId!],
      })
    ).id;
    taskId = await testing.createTask(database, {
      organizationId,
      objectiveId: objectiveId!,
      body: { kind: "typed", prompt: "Past of go?", accepted: ["went"] },
      createdAt: at,
    });

    const post = (path: string, body: unknown) =>
      api.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: learner.cookie },
        body: JSON.stringify(body),
      });
    await post(`/api/courses/${courseId}/attempts`, {
      id: "a1",
      taskId,
      response: { text: "went." },
    });
    await post(`/api/courses/${courseId}/attempts/a1/report`, {
      reason: "answer-correct",
      note: "Only the full stop differs.",
    });
  });

  test("answers an administrator's browser the open reports, in the documented shape, uncacheable", async () => {
    const response = await reportsOf(browser(admin), `?courseId=${courseId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      more: false,
      tasks: [
        {
          id: taskId,
          objectiveId: expect.any(String),
          kind: "typed",
          prompt: "Past of go?",
          accepted: ["went"],
          reportCount: 1,
          reports: [
            {
              id: expect.any(String),
              reason: "answer-correct",
              note: "Only the full stop differs.",
              at: expect.any(String),
              response: { text: "went." },
            },
          ],
        },
      ],
    });
  });

  test("refuses an author, a learner, and a tool, the tool explained, whatever tools may read", async () => {
    expect((await reportsOf(browser(author))).status).toBe(403);
    expect((await reportsOf(browser(learner))).status).toBe(403);
    for (const allowed of [false, true]) {
      await testing.setToolsReadLearnerData(database, organizationId, allowed);
      const read = await reportsOf({ token: admin.token });
      expect(read.status).toBe(403);
      expect(await read.json()).toEqual({ error: expect.stringContaining("console") });
      expect((await dismiss({ token: admin.token }, { reportIds: ["x"] })).status).toBe(403);
    }
    await testing.setToolsReadLearnerData(database, organizationId, false);
  });

  test("refuses a read naming more than one scope, or an empty one", async () => {
    expect((await reportsOf(browser(admin), `?courseId=${courseId}&taskId=${taskId}`)).status).toBe(
      400,
    );
    expect((await reportsOf(browser(admin), `?taskId=${taskId}&taskId=${taskId}`)).status).toBe(
      400,
    );
    expect((await reportsOf(browser(admin), "?taskId=")).status).toBe(400);
  });

  test("dismisses the reports named, 204 again on a retry, and refuses a body that names none", async () => {
    const { tasks } = (await (await reportsOf(browser(admin), `?taskId=${taskId}`)).json()) as {
      tasks: { reports: { id: string }[] }[];
    };
    const reportIds = tasks[0]!.reports.map(({ id }) => id);

    for (const body of [{}, { reportIds: [] }, { reportIds: [""] }, { reportIds: [1] }]) {
      expect((await dismiss(browser(admin), body)).status).toBe(400);
    }
    expect((await dismiss(browser(author), { reportIds })).status).toBe(403);
    expect((await dismiss(browser(admin), { reportIds })).status).toBe(204);
    expect((await dismiss(browser(admin), { reportIds })).status).toBe(204);
    expect(await (await reportsOf(browser(admin))).json()).toEqual({ tasks: [], more: false });
  });
});
