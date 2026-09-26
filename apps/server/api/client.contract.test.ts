// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createAuth } from "../auth/index.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { createApi } from "./app.ts";
import { BraivoError, createClient } from "./client.ts";

/**
 * The client's types are derived from the domain, which says what the routes
 * *should* send; only the routes say what they do send. This drives the real
 * client against the real app, so a route that serializes something other than
 * what the client parses fails here, and so does a client that builds a
 * request the routes refuse.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const auth = createAuth({
  database,
  secret: "contract-test-secret-that-is-long-32",
  baseURL: baseUrl,
});
const api = createApi({ auth, database, baseUrl });

/** The client reaches Braivo over HTTP; here that HTTP is the app itself. */
const client = createClient({
  // The client only ever passes a path, which is what `request` addresses.
  fetch: ((path: string, init?: RequestInit) =>
    api.request(path, init)) as unknown as typeof globalThis.fetch,
});

/** The same app reached at `organizationId`'s own domain, which serves its learn app. */
const organizationHost = "contract-test.example.com";
const onOrganizationDomain = createClient({
  fetch: ((path: string, init?: RequestInit) =>
    api.request(`https://${organizationHost}${path}`, init)) as unknown as typeof globalThis.fetch,
});

const organizationId = "contract-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let learnerCookie!: string;
let learnerId!: string;
let teacherCookie!: string;
let courseId!: string;
/** The learner's organization's, and teaching nothing yet: never anything to practise. */
let emptyCourseId!: string;
let pastTense!: string;
/** The past tense's one task, a choice correct at index 0. */
let pastTenseTask!: string;
let fractions!: string;
let decimals!: string;
/** Three objectives, so a progress report can show every phase at once. */
let progressCourseId!: string;

async function signUp(): Promise<{ cookie: string; id: string }> {
  const email = `contract-${crypto.randomUUID()}@example.com`;
  const signedUp = await api.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", name: email }),
  });
  const cookie = signedUp.headers.get("set-cookie") ?? "";

  const session = await api.request("/api/auth/get-session", { headers: { cookie } });
  const { user } = (await session.json()) as { user: { id: string } };

  return { cookie, id: user.id };
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the client against the real API", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    const learner = await signUp();
    const teacher = await signUp();
    learnerCookie = learner.cookie;
    learnerId = learner.id;
    teacherCookie = teacher.cookie;

    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      adminIds: [teacher.id],
      at,
    });

    await database
      .insert(organizationDomain)
      .values({ hostname: organizationHost, organizationId })
      .onConflictDoNothing();

    pastTense = (await createObjectives(database, organizationId, ["Past tense"]))[0]!;
    courseId = await createCourse(database, {
      organizationId,
      title: "Spanish",
      objectiveIds: [pastTense],
    });
    pastTenseTask = await testing.createTask(database, {
      organizationId,
      objectiveId: pastTense,
      // Kept in order, so the shape below can be pinned exactly.
      body: {
        kind: "choice",
        prompt: "Past tense?",
        options: ["hablé", "hablo"],
        answer: 0,
        keepOrder: true,
      },
      createdAt: at,
    });
    emptyCourseId = await createCourse(database, {
      organizationId,
      title: "Not started",
      objectiveIds: [],
    });
    [fractions, decimals] = (await createObjectives(database, organizationId, [
      "Fractions",
      "Decimals",
    ])) as [string, string];
    progressCourseId = await createCourse(database, {
      organizationId,
      title: "Every phase",
      objectiveIds: [pastTense, fractions, decimals],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learnerId]);
  });

  test("names the organization a domain serves, and none for another", async () => {
    // `seedOrganization` names an organization after its ID.
    expect(await onOrganizationDomain.hostOrganization()).toEqual({ name: organizationId });
    expect(await client.hostOrganization()).toBeUndefined();
  });

  test("parses an activity into the shape it declares", async () => {
    const activity = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });

    // Every field the client's type promises, from the server that really sent
    // it: a rename on either side stops matching here.
    expect(activity).toEqual({
      decision: { objectiveId: pastTense, modelVersion: "v1", intent: "introduce" },
      task: {
        id: pastTenseTask,
        kind: "choice",
        prompt: "Past tense?",
        options: [
          { choice: 0, text: "hablé" },
          { choice: 1, text: "hablo" },
        ],
      },
    });
  });

  test("submits an attempt the server grades, and sees its only task rest", async () => {
    const grade = await client.submitAttempt(
      { courseId, id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 1 } },
      { headers: { cookie: learnerCookie } },
    );
    expect(grade).toEqual({ outcome: "failure", correctChoice: 0 });

    const next = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });
    expect(next).toEqual({ retryAfter: expect.any(Number) });

    const early = client.submitAttempt(
      { courseId, id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 0 } },
      { headers: { cookie: learnerCookie } },
    );
    await expect(early).rejects.toBeInstanceOf(BraivoError);
    await expect(early).rejects.toMatchObject({ status: 409 });
  });

  test("lists a learner's courses in the shape it declares", async () => {
    const courses = await client.learnerCourses({ headers: { cookie: learnerCookie } });

    expect(courses).toEqual([
      { id: progressCourseId, title: "Every phase" },
      { id: emptyCourseId, title: "Not started" },
      { id: courseId, title: "Spanish" },
    ]);
  });

  test("lists the organizations a content owner manages, and none a learner is only in", async () => {
    expect(await client.listOrganizations({ headers: { cookie: teacherCookie } })).toEqual([
      { id: organizationId, name: organizationId, slug: organizationId },
    ]);
    expect(await client.listOrganizations({ headers: { cookie: learnerCookie } })).toEqual([]);
  });

  test("lists courses in the shape it declares, and refuses a learner", async () => {
    const courses = await client.listCourses(organizationId, {
      headers: { cookie: teacherCookie },
    });

    expect(courses).toEqual([
      { id: progressCourseId, title: "Every phase" },
      { id: emptyCourseId, title: "Not started" },
      { id: courseId, title: "Spanish" },
    ]);

    const rejected = await client
      .listCourses(organizationId, { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 403 });
  });

  test("lists objectives in the shape it declares, and refuses a learner", async () => {
    const objectives = await client.listObjectives(organizationId, {
      headers: { cookie: teacherCookie },
    });

    expect(objectives).toEqual([
      { id: decimals, title: "Decimals" },
      { id: fractions, title: "Fractions" },
      { id: pastTense, title: "Past tense" },
    ]);

    const rejected = await client
      .listObjectives(organizationId, { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 403 });
  });

  test("reads nothing to practise as undefined rather than as an error", async () => {
    const activity = await client.nextActivity(emptyCourseId, {
      headers: { cookie: learnerCookie },
    });

    expect(activity).toBeUndefined();
  });

  test("reads a course the learner cannot see as a 404, not as nothing to practise", async () => {
    // The two used to be one answer, and a client holding a stale course ID
    // would have told its learner, indefinitely, that there was nothing to do.
    const rejected = await client
      .nextActivity("no-such-course", { headers: { cookie: learnerCookie } })
      .catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 404 });
  });

  test("records evidence the server accepts, and sees the decision change", async () => {
    // The full loop through the published client: the body it builds is one the
    // server parses, and the decision that comes back reflects it.
    await client.recordEvidence(
      {
        organizationId,
        learnerId,
        evidence: [
          { id: "contract-1", objectiveId: pastTense, outcome: "failure", at: at.toISOString() },
        ],
      },
      { headers: { cookie: teacherCookie } },
    );

    const activity = await client.nextActivity(courseId, { headers: { cookie: learnerCookie } });

    expect(activity && "task" in activity && activity.decision).toEqual({
      objectiveId: pastTense,
      modelVersion: "v1",
      intent: "reteach",
      lastEvidenceAt: at.toISOString(),
    });
  });

  test("parses a progress report into the shape it declares", async () => {
    // Every phase at once, from the server that really sends them, so each
    // phase's fields are pinned as they arrive rather than as they are typed.
    await client.recordEvidence(
      {
        organizationId,
        learnerId,
        evidence: [
          {
            id: "contract-progress-kept",
            objectiveId: pastTense,
            outcome: "success",
            at: at.toISOString(),
          },
          {
            id: "contract-progress-failed",
            objectiveId: fractions,
            outcome: "failure",
            at: at.toISOString(),
          },
        ],
      },
      { headers: { cookie: teacherCookie } },
    );

    const report = await client.learnerProgress(
      { courseId: progressCourseId, learnerId },
      { headers: { cookie: teacherCookie } },
    );

    // Retrievability is read off the real clock, so only its type is pinned;
    // months past a one-day stability is certainly due.
    expect(report).toEqual({
      modelVersion: "v1",
      objectives: [
        {
          objectiveId: pastTense,
          phase: "retaining",
          lastEvidenceAt: at.toISOString(),
          stability: 1,
          retrievability: expect.any(Number),
          due: true,
        },
        { objectiveId: fractions, phase: "acquiring", lastEvidenceAt: at.toISOString() },
        { objectiveId: decimals, phase: "unseen" },
      ],
    });
  });

  test("reads progress the session may not see as a 404", async () => {
    // A learner asking about someone else: only their own is theirs to read.
    const rejected = await client
      .learnerProgress(
        { courseId: progressCourseId, learnerId: "someone-else" },
        { headers: { cookie: learnerCookie } },
      )
      .catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 404 });
  });

  test("surfaces a result that disagrees with its ID's as a 409", async () => {
    // What the client's documentation promises a grader that reuses an ID across
    // attempts, from the server that actually refuses it.
    const send = (outcome: "success" | "failure") =>
      client.recordEvidence(
        {
          organizationId,
          learnerId,
          evidence: [
            { id: "contract-reused", objectiveId: pastTense, outcome, at: at.toISOString() },
          ],
        },
        { headers: { cookie: teacherCookie } },
      );

    await send("failure");
    const rejected = await send("success").catch((thrown: unknown) => thrown);

    expect(rejected).toBeInstanceOf(BraivoError);
    expect(rejected as BraivoError).toMatchObject({ status: 409 });
  });

  test("surfaces a refusal as a BraivoError carrying the status", async () => {
    const rejected = client
      .recordEvidence(
        {
          organizationId,
          learnerId,
          evidence: [
            { id: "contract-2", objectiveId: pastTense, outcome: "success", at: at.toISOString() },
          ],
        },
        // The learner's own session: a member may not grade.
        { headers: { cookie: learnerCookie } },
      )
      .catch((thrown: unknown) => thrown);

    expect(await rejected).toBeInstanceOf(BraivoError);
    expect((await rejected) as BraivoError).toMatchObject({ status: 403 });
  });
});
