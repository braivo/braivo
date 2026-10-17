// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The authoring routes (`authoring.ts`): the organizations an account manages
// and their members, objectives, tasks, courses, and the citations grounding
// them, and the evidence an admin records for a learner. Which host admits each
// route, and each write's refusals and body limit, is `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { task as taskTable } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Model } from "../ai/index.ts";
import { createCourse, createObjectives, createTasks } from "../persistence/index.ts";
import { createApi } from "./app.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, auth, api, signUp } = createTestApi();

const stored = (learnerId: string) => testing.readStoredEvidence(database, learnerId);

const organizationId = "authoring-test-org";
const otherOrganizationId = "authoring-test-other-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let learner!: Signed;
let classmate!: Signed;
/** An admin of the organization, and so the only one here who may author or grade. */
let teacher!: Signed;
let courseId!: string;
let foreignCourseId!: string;
let pastTense!: string;

function next(courseId: string, cookie: string) {
  return api.request(`/api/courses/${courseId}/next`, { headers: { cookie } });
}

function postEvidence(body: unknown, cookie?: string) {
  return api.request(`/api/organizations/${organizationId}/learners/${learner.id}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function postAttempt(courseId: string, body: unknown, cookie: string) {
  return api.request(`/api/courses/${courseId}/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function graded(overrides: Record<string, unknown> = {}) {
  return {
    evidence: [
      {
        id: "api-graded",
        objectiveId: pastTense,
        outcome: "failure",
        at: at.toISOString(),
        ...overrides,
      },
    ],
  };
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the authoring routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    learner = await signUp();
    classmate = await signUp();
    teacher = await signUp();

    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id, classmate.id],
      adminIds: [teacher.id],
      at,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at,
    });

    const objectives = await createObjectives(database, organizationId, ["Past tense"]);
    pastTense = objectives[0]!;
    courseId = await createCourse(database, {
      published: true,
      organizationId,
      title: "Spanish",
      objectiveIds: [pastTense],
    });

    const theirs = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourseId = await createCourse(database, {
      published: true,
      organizationId: otherOrganizationId,
      title: "Somebody else's",
      objectiveIds: [theirs[0]!],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner.id]);
  });

  test("lists the organizations someone manages, uncacheably, and only to a session", async () => {
    const list = (cookie?: string) =>
      api.request("/api/organizations", cookie ? { headers: { cookie } } : undefined);

    const managed = await list(teacher.cookie);
    const anonymous = await list();

    expect(await managed.json()).toEqual({
      organizations: [
        {
          id: organizationId,
          slug: organizationId,
          name: organizationId,
          learnDomain: null,
          administers: true,
          // This API has no model.
          aiEnabled: false,
        },
      ],
    });
    expect(await (await list(learner.cookie)).json()).toEqual({ organizations: [] });
    expect(anonymous.status).toBe(401);
    for (const response of [managed, anonymous]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("says whether an organization's owners may use the installation's AI, as configured", async () => {
    const model = {} as Model;
    const listed = async (organizations: "all" | Set<string>) => {
      const app = createApi({ auth, database, baseUrl, ai: { model, organizations } });
      const response = await app.request("/api/organizations", {
        headers: { cookie: teacher.cookie },
      });
      return ((await response.json()) as { organizations: { aiEnabled?: boolean }[] })
        .organizations;
    };

    expect(await listed(new Set([organizationId]))).toMatchObject([{ aiEnabled: true }]);
    expect(await listed(new Set([otherOrganizationId]))).toMatchObject([{ aiEnabled: false }]);
  });

  test("records what an admin says a learner did, and answers differently after", async () => {
    // Evidence graded elsewhere, over HTTP end to end, changes what the learner
    // is offered next.
    const before = await next(courseId, learner.cookie);
    const recorded = await postEvidence(graded(), teacher.cookie);
    const after = await next(courseId, learner.cookie);

    expect(await before.json()).toMatchObject({ intent: "introduce" });
    expect(recorded.status).toBe(204);
    expect(await after.json()).toMatchObject({ objectiveId: pastTense, intent: "reteach" });
  });

  test("refuses a learner grading themselves", async () => {
    // A learner is a member, and membership alone would be enough to pass every
    // other check on their own material.
    const response = await postEvidence(graded(), learner.cookie);

    expect(response.status).toBe(403);
    expect(await (await next(courseId, learner.cookie)).json()).toMatchObject({
      intent: "introduce",
    });
  });

  test("refuses evidence from a request carrying no session", async () => {
    expect((await postEvidence(graded())).status).toBe(401);
  });

  test("refuses evidence dated too far ahead, and stores none of it", async () => {
    // An hour, well past the five minutes allowed for clocks that disagree, and
    // off the real clock because that is the one the route holds it to.
    const ahead = new Date(Date.now() + 60 * 60_000).toISOString();

    const response = await postEvidence(graded({ id: "api-ahead", at: ahead }), teacher.cookie);

    expect(response.status).toBe(400);
    expect(await stored(learner.id)).toEqual([]);
  });

  test("refuses an evidence ID too long to index as a bad request", async () => {
    const response = await postEvidence(graded({ id: "x".repeat(257) }), teacher.cookie);

    expect(response.status).toBe(400);
    expect(await stored(learner.id)).toEqual([]);
  });

  test.each([
    ["an ID carrying a NUL", { id: "api-\u0000" }, "evidence[0].id"],
    // Stored as U+FFFD, it would be the same ID as `api-\udfff`.
    ["an ID with an unpaired surrogate", { id: "api-\ud800" }, "evidence[0].id"],
    ["an objective ID carrying a NUL", { objectiveId: "\u0000" }, "evidence[0].objectiveId"],
  ])(
    "refuses evidence with %s, naming where, and stores none of it",
    async (_label, overrides, at) => {
      const response = await postEvidence(graded(overrides), teacher.cookie);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: `${at} carries a NUL or an unpaired surrogate, which Braivo cannot store; remove the NUL, or send well-formed Unicode.`,
      });
      expect(await stored(learner.id)).toEqual([]);
    },
  );

  test("refuses a forgeable write before it can record anything", async () => {
    // `policy.test.ts` pins the status for every write; this checks the refusal
    // comes first, so a forged request never reaches the table.
    const simple = await api.request(
      `/api/organizations/${organizationId}/learners/${learner.id}/evidence`,
      {
        method: "POST",
        headers: { "content-type": "text/plain", cookie: teacher.cookie },
        body: JSON.stringify(graded()),
      },
    );

    expect(simple.status).toBe(403);
    expect(await stored(learner.id)).toEqual([]);
  });

  test.each([
    ["application/json; charset=utf-8", 204],
    ["application/jsonp", 403],
    ["application/x-www-form-urlencoded", 403],
  ])("treats %o as %i", async (contentType, status) => {
    const response = await api.request(
      `/api/organizations/${organizationId}/learners/${learner.id}/evidence`,
      {
        method: "POST",
        headers: { "content-type": contentType, cookie: teacher.cookie },
        body: JSON.stringify(graded()),
      },
    );

    expect(response.status).toBe(status);
  });

  test("refuses a batch larger than one statement can carry", async () => {
    const evidence = Array.from({ length: 1001 }, (_unused, index) => ({
      id: `bulk-${index}`,
      objectiveId: pastTense,
      outcome: "success",
      at: at.toISOString(),
    }));

    expect((await postEvidence({ evidence }, teacher.cookie)).status).toBe(400);
  });

  test.each([
    ["not an object", []],
    ["missing evidence", {}],
    ["evidence not an array", { evidence: {} }],
    [
      "an unknown outcome",
      {
        evidence: [{ id: "x", objectiveId: "y", outcome: "maybe", at: "2026-06-01T00:00:00.000Z" }],
      },
    ],
    [
      "an empty id",
      {
        evidence: [
          { id: "", objectiveId: "y", outcome: "success", at: "2026-06-01T00:00:00.000Z" },
        ],
      },
    ],
    [
      "an unparseable date",
      { evidence: [{ id: "x", objectiveId: "y", outcome: "success", at: "whenever" }] },
    ],
    [
      "a numeric date",
      { evidence: [{ id: "x", objectiveId: "y", outcome: "success", at: 1_780_000_000 }] },
    ],
    // `new Date` reads this one as the year 2000. A wrong evidence time is
    // permanent: it reorders replay and moves every review that follows.
    [
      "a date JavaScript would guess at",
      { evidence: [{ id: "x", objectiveId: "y", outcome: "success", at: "1" }] },
    ],
    [
      "a day that does not exist",
      {
        evidence: [
          { id: "x", objectiveId: "y", outcome: "success", at: "2026-02-30T00:00:00.000Z" },
        ],
      },
    ],
    [
      "a timestamp with no zone",
      {
        evidence: [
          { id: "x", objectiveId: "y", outcome: "success", at: "2026-06-01T00:00:00.000" },
        ],
      },
    ],
  ])("rejects a body with %s", async (_label, body) => {
    // A malformed grading result must not become a row in the table every
    // estimate is rebuilt from.
    expect((await postEvidence(body, teacher.cookie)).status).toBe(400);
  });

  test("refuses evidence about an objective another organization owns", async () => {
    const theirs = await createObjectives(database, otherOrganizationId, ["Theirs"]);

    const response = await postEvidence(graded({ objectiveId: theirs[0]! }), teacher.cookie);

    expect(response.status).toBe(403);
  });

  test("answers a redelivered grading result the same way, and stores it once", async () => {
    const first = await postEvidence(graded(), teacher.cookie);
    const again = await postEvidence(graded(), teacher.cookie);

    expect([first.status, again.status]).toEqual([204, 204]);
    expect(await stored(learner.id)).toHaveLength(1);
  });

  test("answers 409 to a result that disagrees with the one already under its ID", async () => {
    // A grader reusing one ID for every attempt at a task: the learner failed,
    // then succeeded.
    const first = await postEvidence(graded({ outcome: "failure" }), teacher.cookie);
    const second = await postEvidence(graded({ outcome: "success" }), teacher.cookie);

    expect([first.status, second.status]).toEqual([204, 409]);
    // The first result stands, and nothing claims the second one landed.
    expect(await (await next(courseId, learner.cookie)).json()).toMatchObject({
      intent: "reteach",
    });
  });

  test("lets an admin retire tasks, refusing a learner, no session, and an invalid batch", async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Retired"]);
    const taskId = await testing.createTask(database, {
      organizationId,
      objectiveId: objectiveId!,
      body: { kind: "choice", prompt: "?", options: ["a", "b"], answer: 0 },
      createdAt: at,
    });
    const retire = (body: unknown, cookie?: string) =>
      api.request(`/api/organizations/${organizationId}/tasks/retire`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie && { cookie }) },
        body: JSON.stringify(body),
      });
    const tooMany = Array.from({ length: 1001 }, () => taskId);

    expect((await retire({ taskIds: [taskId] })).status).toBe(401);
    expect((await retire({ taskIds: [taskId] }, learner.cookie)).status).toBe(403);
    expect((await retire({ taskIds: [""] }, teacher.cookie)).status).toBe(400);
    expect((await retire({ taskIds: tooMany }, teacher.cookie)).status).toBe(400);
    expect((await retire({ taskIds: [taskId] }, teacher.cookie)).status).toBe(204);
    expect((await retire({ taskIds: [taskId] }, teacher.cookie)).status).toBe(204);
  });

  test("lets an admin add tasks, refusing an invalid batch, a learner, and no session", async () => {
    const post = (body: unknown, cookie?: string) =>
      api.request(`/api/organizations/${organizationId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie && { cookie }) },
        body: JSON.stringify(body),
      });
    // An objective of its own, so the tasks added here reach no other test.
    const [objectiveId] = await createObjectives(database, organizationId, ["Authored"]);
    const task = { objectiveId, kind: "choice", prompt: "Which?", options: ["a", "b"] };

    const added = await post({ tasks: [{ ...task, answer: 1 }] }, teacher.cookie);
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ taskIds: [expect.any(String)] });

    // An invalid task is explained; a body that is not tasks at all, below,
    // answers a bare 400.
    const outOfRange = await post({ tasks: [{ ...task, answer: 2 }] }, teacher.cookie);
    expect(outOfRange.status).toBe(400);
    expect(await outOfRange.json()).toEqual({
      error:
        "Task 0 needs its answer to be the index of the correct option, a whole number from 0 to 1.",
    });
    expect((await post({ tasks: [{ ...task, objectiveId: "" }] }, teacher.cookie)).status).toBe(
      400,
    );
    for (const replaces of ["", 7]) {
      expect(
        (await post({ tasks: [{ ...task, answer: 0, replaces }] }, teacher.cookie)).status,
      ).toBe(400);
    }
    // Well under 1 MB, so refused on its count rather than its size.
    const tooMany = Array.from({ length: 1001 }, () => ({ ...task, answer: 1 }));
    expect((await post({ tasks: tooMany }, teacher.cookie)).status).toBe(400);
    // Each quote is a scan of its source, so a request finds at most 200, and
    // a task cites at most 10. At both, it gets as far as the source, which
    // does not exist (403).
    const citing = (count: number) => ({
      ...task,
      answer: 1,
      citations: Array.from({ length: count }, () => ({ sourceId: "s", quote: "q" })),
    });
    const atLimits = Array.from({ length: 20 }, () => citing(10));
    expect((await post({ tasks: atLimits }, teacher.cookie)).status).toBe(403);
    expect((await post({ tasks: [...atLimits, citing(1)] }, teacher.cookie)).status).toBe(400);
    expect((await post({ tasks: [citing(11)] }, teacher.cookie)).status).toBe(400);
    expect((await post({ tasks: [{ ...task, answer: 1 }] }, learner.cookie)).status).toBe(403);
    expect((await post({ tasks: [{ ...task, answer: 1 }] })).status).toBe(401);
  });

  test("lets an admin define objectives and read them back", async () => {
    const created = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        objectives: [{ title: "  Conditional  " }, { title: "Subjunctive" }],
      }),
    });
    const { objectiveIds } = (await created.json()) as { objectiveIds: string[] };

    const listed = await api.request(`/api/organizations/${organizationId}/objectives`, {
      headers: { cookie: teacher.cookie },
    });

    expect(created.status).toBe(201);
    expect(objectiveIds).toHaveLength(2);
    // Titles come back trimmed, and listed by title rather than by creation.
    expect(await listed.json()).toMatchObject({
      objectives: expect.arrayContaining([
        { id: objectiveIds[0]!, title: "Conditional" },
        { id: objectiveIds[1]!, title: "Subjunctive" },
      ]),
    });
  });

  test("sets an organization up end to end, then answers its learner", async () => {
    // Everything a content owner needs, over HTTP and nothing else: name the
    // learning targets, arrange them into a course, and a learner is led
    // through it.
    const defined = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ objectives: [{ title: "Greetings" }, { title: "Numbers" }] }),
    });
    const { objectiveIds } = (await defined.json()) as { objectiveIds: string[] };

    const published = await api.request(`/api/organizations/${organizationId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ title: "Beginners", objectiveIds }),
    });
    const { courseId: fresh } = (await published.json()) as { courseId: string };

    const decision = await next(fresh, learner.cookie);

    expect([defined.status, published.status]).toEqual([201, 201]);
    expect(await decision.json()).toMatchObject({
      objectiveId: objectiveIds[0]!,
      intent: "introduce",
    });
  });

  test("changes a course's URL label for its administrators, over the label read", async () => {
    const id = await createCourse(database, {
      published: true,
      organizationId,
      title: "Everyday English",
      objectiveIds: [],
    });
    const label = (urlLabel: unknown, previous: unknown, cookie = teacher.cookie, course = id) =>
      api.request(`/api/organizations/${organizationId}/courses/${course}/url-label`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ urlLabel, previous }),
      });
    const labelNow = async () => {
      const listed = await api.request(`/api/organizations/${organizationId}/courses`, {
        headers: { cookie: teacher.cookie },
      });
      const { courses } = (await listed.json()) as { courses: { id: string; urlLabel: string }[] };
      return courses.find((course) => course.id === id)?.urlLabel;
    };

    expect((await label("english-a1", "everyday-english")).status).toBe(204);
    // A retry of the same change, as after a lost answer.
    expect((await label("english-a1", "everyday-english")).status).toBe(204);
    expect(await labelNow()).toBe("english-a1");

    const stale = await label("english-b1", "everyday-english");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: expect.stringContaining("read it again"),
      urlLabel: "english-a1",
    });
    for (const malformed of ["", "English", "a--b", "a/b", 7]) {
      expect((await label(malformed, "english-a1")).status).toBe(400);
    }
    expect((await label("english-b1", "english-a1", learner.cookie)).status).toBe(403);
    expect((await label("x", "y", teacher.cookie, "no-such-course")).status).toBe(404);
    expect((await label("x", "y", teacher.cookie, foreignCourseId)).status).toBe(404);
    expect(await labelNow()).toBe("english-a1");
  });

  test("keeps a tool's course from learners until a person publishes it in the console", async () => {
    const [proposedObjective] = await createObjectives(database, organizationId, ["Proposed"]);
    const [taskId] = await createTasks(
      database,
      organizationId,
      [
        {
          objectiveId: proposedObjective!,
          body: { kind: "choice", prompt: "¿Sí?", options: ["yes", "no"], answer: 0 },
        },
      ],
      at,
      { published: true },
    );
    const asTool = { "content-type": "application/json", authorization: `Bearer ${teacher.token}` };
    const inConsole = { "content-type": "application/json", cookie: teacher.cookie };
    const create = (headers: Record<string, string>) =>
      api.request(`/api/organizations/${organizationId}/courses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Proposed",
          objectiveIds: [proposedObjective],
          key: "proposed",
        }),
      });
    const publish = (headers: Record<string, string>, courseIds: string[]) =>
      api.request(`/api/organizations/${organizationId}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({ courseIds }),
      });
    const listed = async () =>
      (
        (await (
          await api.request("/api/courses", { headers: { cookie: learner.cookie } })
        ).json()) as {
          courses: { id: string }[];
        }
      ).courses.map(({ id }) => id);
    // What the console shows its administrators: in the list, then on its page.
    const shownAsPublished = async () => {
      const read = async <T>(path: string) =>
        (await (await api.request(path, { headers: { cookie: teacher.cookie } })).json()) as T;
      const { courses } = await read<{ courses: { id: string; published: boolean }[] }>(
        `/api/organizations/${organizationId}/courses`,
      );
      const course = await read<{ published: boolean }>(
        `/api/organizations/${organizationId}/courses/${proposed}`,
      );
      return [courses.find(({ id }) => id === proposed)?.published, course.published];
    };
    const asLearner = { headers: { cookie: learner.cookie } };
    const progress = (cookie: string) =>
      api.request(`/api/courses/${proposed}/learners/${learner.id}/progress`, {
        headers: { cookie },
      });

    const created = await create(asTool);
    expect(created.status).toBe(201);
    const { courseId: proposed } = (await created.json()) as { courseId: string };

    // To its learners, as if there were no such course.
    expect(await listed()).not.toContain(proposed);
    expect((await next(proposed, learner.cookie)).status).toBe(404);
    expect((await api.request(`/api/courses/${proposed}/activity`, asLearner)).status).toBe(404);
    const attempt = { id: "unpublished-attempt", taskId, response: { choice: 0 } };
    expect((await postAttempt(proposed, attempt, learner.cookie)).status).toBe(404);
    expect(await stored(learner.id)).toEqual([]);
    expect((await progress(learner.cookie)).status).toBe(404);
    // Those reading for learners still read it, told it waits.
    expect((await progress(teacher.cookie)).status).toBe(200);
    const overview = await api.request(`/api/courses/${proposed}/progress`, {
      headers: { cookie: teacher.cookie },
    });
    expect(await overview.json()).toMatchObject({ published: false });
    // A keyed retry from the console finds it, still waiting.
    expect(await (await create(inConsole)).json()).toEqual({ courseId: proposed });
    expect(await listed()).not.toContain(proposed);

    // Only a person in the console publishes, all or none: not a tool, even
    // alongside the session, nor a member who does not administer it.
    expect((await publish(asTool, [proposed])).status).toBe(403);
    expect((await publish({ ...inConsole, ...asTool }, [proposed])).status).toBe(403);
    expect((await publish({ ...inConsole, cookie: learner.cookie }, [proposed])).status).toBe(403);
    expect((await publish(inConsole, [proposed, foreignCourseId])).status).toBe(409);
    expect(await listed()).not.toContain(proposed);
    expect(await shownAsPublished()).toEqual([false, false]);
    expect((await publish(inConsole, [proposed])).status).toBe(204);
    expect(await shownAsPublished()).toEqual([true, true]);

    expect(await listed()).toContain(proposed);
    expect((await next(proposed, learner.cookie)).status).toBe(200);
    expect((await postAttempt(proposed, attempt, learner.cookie)).status).toBe(200);
    expect(await stored(learner.id)).toHaveLength(1);
  });

  describe("task publication", () => {
    let asTool!: Record<string, string>;
    let inConsole!: Record<string, string>;
    beforeAll(() => {
      asTool = { "content-type": "application/json", authorization: `Bearer ${teacher.token}` };
      inConsole = { "content-type": "application/json", cookie: teacher.cookie };
    });
    const choice = (prompt: string) => ({
      kind: "choice",
      prompt,
      options: ["yes", "no"],
      answer: 0,
    });
    const write = (headers: Record<string, string>, tasks: unknown[]) =>
      api.request(`/api/organizations/${organizationId}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tasks }),
      });
    const written = async (headers: Record<string, string>, tasks: unknown[]) => {
      const response = await write(headers, tasks);
      expect(response.status).toBe(201);
      return ((await response.json()) as { taskIds: string[] }).taskIds;
    };
    const retire = (headers: Record<string, string>, taskIds: string[]) =>
      api.request(`/api/organizations/${organizationId}/tasks/retire`, {
        method: "POST",
        headers,
        body: JSON.stringify({ taskIds }),
      });
    const publish = (headers: Record<string, string>, body: unknown) =>
      api.request(`/api/organizations/${organizationId}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    /**
     * An objective's tasks as its administrators read them: ID, whether it is
     * published, and the task a waiting correction replaces.
     */
    const states = async (objectiveId: string) => {
      const response = await api.request(
        `/api/organizations/${organizationId}/objectives/${objectiveId}/tasks`,
        { headers: { cookie: teacher.cookie } },
      );
      expect(response.status).toBe(200);
      const { tasks } = (await response.json()) as {
        tasks: { id: string; published: boolean; replaces?: string }[];
      };
      return tasks.map(({ id, published, replaces }) =>
        replaces === undefined ? [id, published] : [id, published, replaces],
      );
    };
    /** A course's tasks as its page reads them, by objective: as `states` gives them. */
    const courseStates = async (courseId: string) => {
      const response = await api.request(
        `/api/organizations/${organizationId}/courses/${courseId}`,
        { headers: { cookie: teacher.cookie } },
      );
      expect(response.status).toBe(200);
      const { objectives } = (await response.json()) as {
        objectives: { tasks: { id: string; published: boolean; replaces?: string }[] }[];
      };
      return objectives.flatMap(({ tasks }) =>
        tasks.map(({ id, published, replaces }) =>
          replaces === undefined ? [id, published] : [id, published, replaces],
        ),
      );
    };
    /** The task a learner is offered in a course, if any. */
    const offered = async (courseId: string) => {
      const response = await api.request(`/api/courses/${courseId}/activity?timeZone=UTC`, {
        headers: { cookie: learner.cookie },
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { task?: { id: string } }).task?.id;
    };
    const publishedAt = async (taskIds: string[]) =>
      (
        await database
          .select({ id: taskTable.id, publishedAt: taskTable.publishedAt })
          .from(taskTable)
          .where(inArray(taskTable.id, taskIds))
          .orderBy(taskTable.id)
      ).map((row) => row.publishedAt?.getTime() ?? null);
    const published = async (taskIds: string[]) =>
      (await publishedAt(taskIds)).map((time) => time !== null);
    /** An objective of its own in two published courses, so nothing here reaches another test. */
    const sharedObjective = async (title: string) => {
      const [objectiveId] = (await createObjectives(database, organizationId, [title])) as [string];
      const courses = await Promise.all(
        ["One", "Two"].map((course) =>
          createCourse(database, {
            published: true,
            organizationId,
            title: `${title}: ${course}`,
            objectiveIds: [objectiveId],
          }),
        ),
      );
      return { objectiveId, courses: courses as [string, string] };
    };

    test("keeps a tool's tasks from learners in every course until a person publishes them", async () => {
      const { objectiveId, courses } = await sharedObjective("Shared");
      const tasks = await written(
        asTool,
        ["1", "2", "3", "4", "5"].map((prompt) => ({ objectiveId, ...choice(prompt) })),
      );

      // Waiting: in neither course an activity, nor answerable by naming it.
      for (const course of courses) expect(await offered(course)).toBeUndefined();
      const attempt = { id: "waiting-attempt", taskId: tasks[0], response: { choice: 0 } };
      expect((await postAttempt(courses[0], attempt, learner.cookie)).status).toBe(404);
      expect(await stored(learner.id)).toEqual([]);
      // Its administrators read them, told they wait, and which other course they would reach.
      expect(await states(objectiveId)).toEqual(tasks.map((id) => [id, false]));
      const page = (await (
        await api.request(`/api/organizations/${organizationId}/courses/${courses[0]}`, {
          headers: { cookie: teacher.cookie },
        })
      ).json()) as {
        objectives: { tasks: { published: boolean }[]; otherPublishedCourses: { id: string }[] }[];
      };
      expect(page.objectives[0]!.tasks.map(({ published }) => published)).toEqual(
        tasks.map(() => false),
      );
      expect(page.objectives[0]!.otherPublishedCourses).toEqual([
        { id: courses[1], title: "Shared: Two" },
      ]);

      // Two of them published, in the console: both courses offer them, the rest still wait.
      expect((await publish(inConsole, { taskIds: tasks.slice(0, 2) })).status).toBe(204);
      for (const course of courses) expect(tasks.slice(0, 2)).toContain(await offered(course));
      expect(await states(objectiveId)).toEqual(tasks.map((id, index) => [id, index < 2]));
      const waiting = { id: "still-waiting", taskId: tasks[2], response: { choice: 0 } };
      expect((await postAttempt(courses[1], waiting, learner.cookie)).status).toBe(404);
      expect((await postAttempt(courses[1], attempt, learner.cookie)).status).toBe(200);
    });

    test("holds a tool's correction of published practice and refuses its retirement", async () => {
      const { objectiveId, courses } = await sharedObjective("Guarded");
      const [live] = (await written(inConsole, [{ objectiveId, ...choice("Live") }])) as [string];
      const [proposed] = (await written(asTool, [{ objectiveId, ...choice("Proposed") }])) as [
        string,
      ];

      // A correction of a published task waits beside it, the task still offered in every course.
      const [pending] = (await written(asTool, [
        { objectiveId, ...choice("Live"), answer: 1, replaces: live },
      ])) as [string];
      expect(await states(objectiveId)).toEqual([
        [live, true],
        [proposed, false],
        [pending, false, live],
      ]);
      for (const courseId of courses) expect(await offered(courseId)).toBe(live);
      expect(await courseStates(courses[0]!)).toEqual(await states(objectiveId));
      // One waits at a time: another is refused, coded, naming the one to correct instead.
      const second = await write(asTool, [
        { objectiveId, ...choice("Live, again"), replaces: live },
      ]);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error: expect.stringContaining(`replaces "${pending}"`),
        code: "CORRECTION_WAITING",
      });
      // Retiring a published task is the console's, explained.
      const retirement = await retire(asTool, [proposed, live]);
      expect(retirement.status).toBe(403);
      expect(await retirement.json()).toEqual({
        error: expect.stringContaining("Braivo's console"),
      });
      // Its own waiting task, a tool may correct and retire; the correction waits too.
      const [corrected] = (await written(asTool, [
        { objectiveId, ...choice("Proposed"), answer: 1, replaces: proposed },
      ])) as [string];
      expect((await retire(asTool, [corrected])).status).toBe(204);
      expect(await states(objectiveId)).toEqual([
        [live, true],
        [pending, false, live],
      ]);

      // In the console, a correction takes the state of the task it replaces,
      // and replacing a published one retires its waiting correction too.
      const [draft] = (await written(asTool, [{ objectiveId, ...choice("Draft") }])) as [string];
      const [redrafted] = (await written(inConsole, [
        { objectiveId, ...choice("Draft"), answer: 1, replaces: draft },
      ])) as [string];
      const [fixed] = (await written(inConsole, [
        { objectiveId, ...choice("Live"), answer: 1, prompt: "Live, fixed", replaces: live },
      ])) as [string];
      expect(await states(objectiveId)).toEqual([
        [redrafted, false],
        [fixed, true],
      ]);
      // Equal to another task of the objective: refused, coded apart from a stale correction.
      const duplicate = await write(inConsole, [
        { objectiveId, ...choice("Draft"), answer: 1, replaces: fixed },
      ]);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "DUPLICATE_CORRECTION" });
      expect((await retire(inConsole, [fixed])).status).toBe(204);

      // Retired since, a published task's correction is stale, and its retirement still refused.
      const late = await write(asTool, [{ objectiveId, ...choice("Live"), replaces: fixed }]);
      expect(late.status).toBe(409);
      expect(await late.json()).toEqual({ error: expect.stringContaining("already retired") });
      const lateRetirement = await retire(asTool, [fixed]);
      expect(lateRetirement.status).toBe(403);
      expect(await lateRetirement.json()).toEqual({ error: expect.stringContaining("retired") });
    });

    test("publishes a waiting correction and retires its task together", async () => {
      const { objectiveId, courses } = await sharedObjective("Corrected");
      const [live] = (await written(inConsole, [{ objectiveId, ...choice("Before") }])) as [string];
      const [pending] = (await written(asTool, [
        { objectiveId, ...choice("Before"), answer: 1, replaces: live },
      ])) as [string];

      expect(await courseStates(courses[0]!)).toEqual([
        [live, true],
        [pending, false, live],
      ]);
      expect((await publish(inConsole, { taskIds: [pending] })).status).toBe(204);
      // Published, it no longer reads as a correction.
      expect(await courseStates(courses[0]!)).toEqual([[pending, true]]);
      for (const courseId of courses) expect(await offered(courseId)).toBe(pending);
      // A retry changes nothing.
      expect((await publish(inConsole, { taskIds: [pending] })).status).toBe(204);
      expect(await states(objectiveId)).toEqual([[pending, true]]);
    });

    test("publishes all or nothing, only from the console, a retry changing nothing", async () => {
      const { objectiveId } = await sharedObjective("Atomic");
      const create = await api.request(`/api/organizations/${organizationId}/courses`, {
        method: "POST",
        headers: asTool,
        body: JSON.stringify({ title: "Atomic: proposed", objectiveIds: [objectiveId] }),
      });
      const { courseId: proposed } = (await create.json()) as { courseId: string };
      const [first, second, withdrawn, superseded] = (await written(
        asTool,
        ["1", "2", "3", "4"].map((prompt) => ({ objectiveId, ...choice(prompt) })),
      )) as [string, string, string, string];
      expect((await retire(asTool, [withdrawn])).status).toBe(204);
      await written(inConsole, [{ objectiveId, ...choice("4"), answer: 1, replaces: superseded }]);
      const [theirs] = (await createObjectives(database, otherOrganizationId, ["Theirs too"])) as [
        string,
      ];
      const foreign = await testing.createTask(database, {
        organizationId: otherOrganizationId,
        objectiveId: theirs,
        body: choice("Theirs"),
        createdAt: at,
        publishedAt: null,
      });
      const courseShown = async () =>
        (
          (await (
            await api.request(`/api/organizations/${organizationId}/courses/${proposed}`, {
              headers: { cookie: teacher.cookie },
            })
          ).json()) as { published: boolean }
        ).published;

      // Refused whole: a task retired or replaced since, another organization's, a tool.
      for (const stale of [withdrawn, superseded]) {
        const response = await publish(inConsole, {
          courseIds: [proposed],
          taskIds: [first, stale],
        });
        expect(response.status).toBe(409);
      }
      expect((await publish(inConsole, { taskIds: [first, foreign] })).status).toBe(403);
      expect((await publish(asTool, { courseIds: [proposed], taskIds: [first] })).status).toBe(403);
      expect(await published([first, foreign])).toEqual([false, false]);
      expect(await courseShown()).toBe(false);
      // Up to 10,000 IDs in all: a course page's whole waiting work, in one request.
      const tooMany = {
        courseIds: [proposed],
        taskIds: Array.from({ length: 10_000 }, () => first),
      };
      for (const body of [{}, { taskIds: [] }, { taskIds: [""] }, { taskIds: "x" }, tooMany]) {
        expect((await publish(inConsole, body)).status).toBe(400);
      }

      // The course and its tasks together; sent again, the same answer and nothing changed.
      const both = { courseIds: [proposed], taskIds: [first, second] };
      expect((await publish(inConsole, both)).status).toBe(204);
      expect(await courseShown()).toBe(true);
      const when = await publishedAt([first, second]);
      expect(when.every((time) => time !== null)).toBe(true);
      expect((await publish(inConsole, both)).status).toBe(204);
      expect(await publishedAt([first, second])).toEqual(when);
      // 10,000 IDs in all are taken, a repeat counted as often as it is sent.
      const atLimit = {
        courseIds: [proposed],
        taskIds: Array.from({ length: 9_999 }, () => first),
      };
      expect((await publish(inConsole, atLimit)).status).toBe(204);
      expect(await publishedAt([first, second])).toEqual(when);
    });

    test("holds a bank's import at its size: 257 tasks in two batches, 20 published", async () => {
      const objectiveIds = await createObjectives(
        database,
        organizationId,
        Array.from({ length: 25 }, (_, index) => `Quesito ${index + 1}`),
      );
      const course = await createCourse(database, {
        published: true,
        organizationId,
        title: "Patente: primi 25 quesiti",
        objectiveIds,
      });
      const statements = Array.from({ length: 257 }, (_, index) => ({
        objectiveId: objectiveIds[index % 25],
        ...choice(`Statement ${index + 1}`),
        options: ["Vero", "Falso"],
        keepOrder: true,
      }));
      const taskIds = [
        ...(await written(asTool, statements.slice(0, 130))),
        ...(await written(asTool, statements.slice(130))),
      ];
      const waiting = async () => {
        const response = await api.request(
          `/api/organizations/${organizationId}/courses/${course}`,
          { headers: { cookie: teacher.cookie } },
        );
        expect(response.status).toBe(200);
        const { objectives } = (await response.json()) as {
          objectives: { tasks: { published: boolean }[] }[];
        };
        return objectives.flatMap(({ tasks }) => tasks).filter(({ published }) => !published)
          .length;
      };
      expect(new Set(taskIds).size).toBe(257);
      expect(await waiting()).toBe(257);

      // The reviewer's selection, captured before a later task arrives.
      const selection = taskIds.slice(0, 20);
      await written(asTool, [{ objectiveId: objectiveIds[0], ...choice("Arrived later") }]);
      expect((await publish(inConsole, { taskIds: selection })).status).toBe(204);
      expect(await waiting()).toBe(238);
      expect(await published(taskIds)).toEqual(
        taskIds
          .map((id, index) => [id, index < 20] as const)
          .toSorted(([a], [b]) => (a < b ? -1 : 1))
          .map(([, state]) => state),
      );
    });
  });

  test("lists the courses an organization has", async () => {
    const listed = await api.request(`/api/organizations/${organizationId}/courses`, {
      headers: { cookie: teacher.cookie },
    });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      courses: expect.arrayContaining([
        {
          id: courseId,
          number: expect.any(Number),
          title: "Spanish",
          urlLabel: "spanish",
          published: true,
          waitingTaskCount: 0,
        },
      ]),
    });
  });

  test("refuses a course over another organization's objective, without a 500", async () => {
    // The schema would refuse this too, but as a constraint violation. The
    // application asks first so it stays an answer.
    const theirs = await createObjectives(database, otherOrganizationId, ["Theirs"]);

    const response = await api.request(`/api/organizations/${organizationId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ title: "Borrowed", objectiveIds: [theirs[0]!] }),
    });

    expect(response.status).toBe(403);
  });

  const refusedTitle =
    "has a title that is blank, over 500 characters, or carries a NUL or an unpaired surrogate, which Braivo cannot store as text.";
  /** Refused by `storableJson`, before any route's parser reads the body. */
  const unstorable = (at: string) =>
    `${at} carries a NUL or an unpaired surrogate, which Braivo cannot store; remove the NUL, or send well-formed Unicode.`;

  test.each([
    ["no title", { objectiveIds: [] }, undefined],
    ["a blank title", { title: "  ", objectiveIds: [] }, `The course ${refusedTitle}`],
    ["a title carrying a NUL", { title: "Course\u0000", objectiveIds: [] }, unstorable("title")],
    [
      "a title past 500 characters",
      { title: "C".repeat(501), objectiveIds: [] },
      `The course ${refusedTitle}`,
    ],
    ["no objectiveIds", { title: "Course" }, undefined],
    [
      "a duplicated objective",
      { title: "Course", objectiveIds: ["a", "b", "a"] },
      "The course lists objective 0 again as objective 2; a course lists each objective once.",
    ],
    ["an empty objective id", { title: "Course", objectiveIds: [""] }, undefined],
  ])("rejects a course with %s", async (_label, body, error) => {
    // A learner's cookie: what was sent is refused before who sent it is read.
    const response = await api.request(`/api/organizations/${organizationId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    // Explained when it is what was said; a body not of the shape is bare.
    expect(await response.text()).toBe(error === undefined ? "" : JSON.stringify({ error }));
  });

  test("refuses a learner creating or listing courses", async () => {
    const publishing = await api.request(`/api/organizations/${organizationId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: JSON.stringify({ title: "Snuck in", objectiveIds: [] }),
    });
    const listing = await api.request(`/api/organizations/${organizationId}/courses`, {
      headers: { cookie: learner.cookie },
    });

    expect([publishing.status, listing.status]).toEqual([403, 403]);
  });

  test("lists an organization's members to its admin, in the public shape", async () => {
    const response = await api.request(`/api/organizations/${organizationId}/members`, {
      headers: { cookie: teacher.cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { members } = (await response.json()) as { members: unknown[] };
    // Whole objects, so an email or any other field fails.
    const name = expect.any(String);
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: learner.id, name, roles: ["member"] },
        { userId: classmate.id, name, roles: ["member"] },
        { userId: teacher.id, name, roles: ["admin"] },
      ]),
    );
    expect(members).toHaveLength(3);
  });

  test("refuses the roster to a learner, an outsider, and a visitor not signed in", async () => {
    const roster = (organization: string, cookie?: string) =>
      api.request(
        `/api/organizations/${organization}/members`,
        cookie ? { headers: { cookie } } : undefined,
      );

    const statuses = await Promise.all([
      roster(organizationId, learner.cookie),
      roster(otherOrganizationId, teacher.cookie),
      roster(organizationId),
    ]);

    expect(statuses.map((response) => response.status)).toEqual([403, 403, 401]);
  });

  test("refuses a learner authoring or listing objectives", async () => {
    const defining = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: JSON.stringify({ objectives: [{ title: "Snuck in" }] }),
    });
    const listing = await api.request(`/api/organizations/${organizationId}/objectives`, {
      headers: { cookie: learner.cookie },
    });

    expect([defining.status, listing.status]).toEqual([403, 403]);
  });

  test.each([
    ["objectives missing", {}, undefined],
    ["objectives not an array", { objectives: "Conditional" }, undefined],
    ["a bare title", { objectives: ["Conditional"] }, undefined],
    ["a blank title", { objectives: [{ title: "   " }] }, `Objective 0 ${refusedTitle}`],
    [
      "a title with an unpaired surrogate",
      { objectives: [{ title: "Present" }, { title: "Past \ud800" }] },
      unstorable("objectives[1].title"),
    ],
    [
      "a title past 500 characters",
      { objectives: [{ title: "P".repeat(501) }] },
      `Objective 0 ${refusedTitle}`,
    ],
    ["a title that is not a string", { objectives: [{ title: 7 }] }, undefined],
    ["a key that is not a string", { objectives: [{ title: "Conditional", key: 7 }] }, undefined],
  ])("rejects a definition with %s", async (_label, body, error) => {
    const response = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(error === undefined ? "" : JSON.stringify({ error }));
  });

  test("returns a keyed objective or course again, and explains a key that names another", async () => {
    const define = (objectives: unknown) =>
      api.request(`/api/organizations/${organizationId}/objectives`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify({ objectives }),
      });
    const create = (course: unknown) =>
      api.request(`/api/organizations/${organizationId}/courses`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify(course),
      });
    // Unique per run, since keys and courses outlive the test in this organization.
    const run = crypto.randomUUID().slice(0, 8);

    const first = await define([{ title: "Colors", key: `api-${run}/colors` }]);
    const again = await define([{ title: "Colors", key: `api-${run}/colors` }]);
    const [colors] = ((await first.json()) as { objectiveIds: string[] }).objectiveIds;
    const renamed = await define([{ title: "Colours", key: `api-${run}/colors` }]);
    const malformed = await define([{ title: "Colors", key: "Not A Key" }]);

    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await again.json()).toEqual({ objectiveIds: [colors] });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toEqual({
      error: `Objective 0 has key "api-${run}/colors", which already names an objective with another title; use another key, or send exactly what it names.`,
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: expect.stringContaining("lowercase") });

    const course = { title: `Colores ${run}`, objectiveIds: [colors], key: `api-${run}/colores` };
    const created = await create(course);
    const recreated = await create(course);
    const reordered = await create({ ...course, objectiveIds: [] });
    const listed = await api.request(`/api/organizations/${organizationId}/courses`, {
      headers: { cookie: teacher.cookie },
    });
    const { courses } = (await listed.json()) as { courses: { id: string; title: string }[] };

    const { courseId: keyed } = (await created.json()) as { courseId: string };
    expect(await recreated.json()).toEqual({ courseId: keyed });
    expect(reordered.status).toBe(409);
    expect(await reordered.json()).toMatchObject({ error: expect.stringContaining("The course") });
    // The refused request stored nothing: one course has the title, the keyed one.
    expect(courses.filter(({ title }) => title === course.title)).toEqual([
      {
        id: keyed,
        number: expect.any(Number),
        title: course.title,
        urlLabel: expect.any(String),
        published: true,
        waitingTaskCount: 0,
      },
    ]);
  });

  /** A source for the tasks and citations below to cite. */
  function postSource(body: unknown, cookie: string) {
    return api.request(`/api/organizations/${organizationId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  }

  test("reads a course as authored, in order, only for who administers it", async () => {
    const added = await postSource({ title: "Colores", text: "Rojo es red." }, teacher.cookie);
    const { sourceId } = (await added.json()) as { sourceId: string };
    const [red, blue] = await createObjectives(database, organizationId, ["Red", "Blue"]);
    await api.request(`/api/organizations/${organizationId}/citations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        citations: [{ objectiveId: red, sourceId, quote: "Rojo es red." }],
      }),
    });
    const [taskId] = await createTasks(
      database,
      organizationId,
      [
        {
          objectiveId: red!,
          body: { kind: "choice", prompt: "¿Rojo?", options: ["red", "blue"], answer: 0 },
        },
      ],
      at,
      { published: true },
    );
    const colors = await createCourse(database, {
      published: true,
      organizationId,
      title: "Colores",
      objectiveIds: [blue!, red!],
    });
    const read = (courseId: string, cookie: string) =>
      api.request(`/api/organizations/${organizationId}/courses/${courseId}`, {
        headers: { cookie },
      });

    const course = await read(colors, teacher.cookie);
    expect(course.status).toBe(200);
    expect(await course.json()).toEqual({
      id: colors,
      number: expect.any(Number),
      title: "Colores",
      urlLabel: "colores",
      published: true,
      objectives: [
        { id: blue, title: "Blue", citations: [], tasks: [], otherPublishedCourses: [] },
        {
          id: red,
          title: "Red",
          citations: [{ sourceId, start: 0, end: 12, quote: "Rojo es red." }],
          tasks: [
            {
              id: taskId,
              kind: "choice",
              prompt: "¿Rojo?",
              options: ["red", "blue"],
              answer: 0,
              citations: [],
              published: true,
            },
          ],
          otherPublishedCourses: [],
        },
      ],
      sources: [{ id: sourceId, title: "Colores", createdAt: expect.any(String) }],
    });
    expect((await read(colors, learner.cookie)).status).toBe(403);
    // Another organization's course, even through one the caller administers.
    expect((await read(foreignCourseId, teacher.cookie)).status).toBe(404);
  });

  test("shows an objective's tasks, as authored, only to who administers it", async () => {
    const [counting] = await createObjectives(database, organizationId, ["Counting"]);
    const [taskId] = await createTasks(
      database,
      organizationId,
      [
        {
          objectiveId: counting!,
          body: { kind: "choice", prompt: "¿Tres?", options: ["three", "four"], answer: 0 },
        },
      ],
      at,
      { published: true },
    );
    const read = (objectiveId: string, cookie: string) =>
      api.request(`/api/organizations/${organizationId}/objectives/${objectiveId}/tasks`, {
        headers: { cookie },
      });

    const listed = await read(counting!, teacher.cookie);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      tasks: [
        {
          id: taskId,
          kind: "choice",
          prompt: "¿Tres?",
          options: ["three", "four"],
          answer: 0,
          citations: [],
          published: true,
        },
      ],
    });
    // Answers included, so never a learner's to read.
    expect((await read(counting!, learner.cookie)).status).toBe(403);
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Their counting"]);
    expect((await read(theirs!, teacher.cookie)).status).toBe(404);
  });

  test("authors a task grounded in a source, and shows its passage once it is answered", async () => {
    // An objective and course of its own, so the task joins no other test's rotation.
    const [colours] = await createObjectives(database, organizationId, ["Colours"]);
    const coloursCourse = await createCourse(database, {
      published: true,
      organizationId,
      title: "Colours",
      objectiveIds: [colours!],
    });
    const added = await postSource(
      {
        title: "Unidad 3",
        text: "Los colores: rojo, azul, verde.",
        url: "https://www.youtube.com/watch?v=colores",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const question = { kind: "choice", prompt: "¿Rojo?", options: ["red", "blue"], answer: 0 };
    const author = (citations: unknown) =>
      api.request(`/api/organizations/${organizationId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify({ tasks: [{ objectiveId: colours, ...question, citations }] }),
      });

    const grounded = await author([{ sourceId, quote: "rojo, azul" }]);
    const invented = await author([{ sourceId, quote: "amarillo" }]);
    const tooMany = await author(Array.from({ length: 11 }, () => ({ sourceId, quote: "rojo" })));
    const malformed = await author([{ sourceId }]);

    expect(grounded.status).toBe(201);
    expect(invented.status).toBe(400);
    expect(await invented.json()).toEqual({
      error: "Task 0, citation 0: the quote does not occur in the source.",
    });
    expect([tooMany.status, malformed.status]).toEqual([400, 400]);

    const [taskId] = ((await grounded.json()) as { taskIds: string[] }).taskIds;
    const answered = await postAttempt(
      coloursCourse,
      { id: crypto.randomUUID(), taskId, response: { choice: 1 } },
      learner.cookie,
    );

    expect(await answered.json()).toEqual({
      kind: "choice",
      outcome: "failure",
      correctChoice: 0,
      passages: [
        {
          quote: "rojo, azul",
          source: { title: "Unidad 3", url: "https://www.youtube.com/watch?v=colores" },
        },
      ],
    });
  });

  test("grounds an objective in a source, end to end, as an agent drafting from it would", async () => {
    const added = await postSource(
      { title: "Unidad 2", text: "Los números: uno, dos, tres.", language: "es" },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const defined = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ objectives: [{ title: "Counting to three" }] }),
    });
    const [objectiveId] = ((await defined.json()) as { objectiveIds: string[] }).objectiveIds;

    const cite = (quote: string, cookie = teacher.cookie, times = 1) =>
      api.request(`/api/organizations/${organizationId}/citations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          citations: Array.from({ length: times }, () => ({ objectiveId, sourceId, quote })),
        }),
      });

    const cited = await cite("uno, dos, tres.");
    const invented = await cite("cuatro, cinco");
    const byLearner = await cite("uno, dos, tres.", learner.cookie);
    // Each quote is a scan of its source, so a request locates at most 200.
    const atLimit = await cite("uno, dos, tres.", teacher.cookie, 200);
    const overLimit = await cite("uno, dos, tres.", teacher.cookie, 201);
    const read = await api.request(
      `/api/organizations/${organizationId}/objectives/${objectiveId}/citations`,
      { headers: { cookie: teacher.cookie } },
    );

    expect(cited.status).toBe(200);
    expect(await cited.json()).toEqual({
      citations: [{ objectiveId, sourceId, start: 13, end: 28 }],
    });
    // Explained, so a model can correct its quote.
    expect(invented.status).toBe(400);
    expect(await invented.json()).toEqual({
      error: "Citation 0: the quote does not occur in the source.",
    });
    expect(byLearner.status).toBe(403);
    expect([atLimit.status, overLimit.status]).toEqual([200, 400]);
    expect(await read.json()).toEqual({
      citations: [{ sourceId, start: 13, end: 28, quote: "uno, dos, tres." }],
    });
    expect(read.headers.get("cache-control")).toBe("private, no-store");
  });
});
