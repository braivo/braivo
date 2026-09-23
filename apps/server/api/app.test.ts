// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createAuth } from "../auth/index.ts";
import { activeModel } from "../learning/index.ts";
import {
  createCourse,
  createObjectives,
  readLearnerEvidence,
  recordEvidence,
} from "../persistence/index.ts";
import { createApi } from "./app.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

/** Everything stored for a learner, future-dated records included. */
const stored = (learnerId: string) =>
  readLearnerEvidence(database, learnerId, new Date("9999-12-31T23:59:59.999Z"));
const auth = createAuth({
  database,
  secret: "api-test-secret-that-is-long-enough-32",
  baseURL: "http://localhost:3000",
});
const baseUrl = "http://localhost:3000";
const api = createApi({ auth, database, baseUrl });

const organizationId = "api-test-org";
const otherOrganizationId = "api-test-other-org";
const at = new Date("2026-06-01T00:00:00.000Z");
/**
 * Evidence is dated relative to the real clock, because the route reads it:
 * thirty days is comfortably past due for an objective whose stability is one
 * day, whenever the suite happens to run. Whole seconds, so the timestamp that
 * comes back out of PostgreSQL is the one that went in.
 */
const recordedAt = new Date(Math.floor((Date.now() - 30 * 86_400_000) / 1000) * 1000);

let learner!: Signed;
let classmate!: Signed;
/** An admin of the organization, and so the only one here who may grade. */
let teacher!: Signed;
let courseId!: string;
/** The learner's organization's, and teaching nothing yet: always caught up. */
let emptyCourseId!: string;
let foreignCourseId!: string;
let pastTense!: string;
/** A choice task on the past tense, correct at index 0. */
let pastTenseTask!: string;

type Signed = { cookie: string; id: string };

/**
 * Signs a new learner up through the mounted Better Auth handler, which is the
 * only way to obtain a real session — and incidentally proves the mount works.
 * A fresh email each run, so a rerun never collides with a leftover account.
 */
async function signUp(): Promise<Signed> {
  const email = `api-test-${crypto.randomUUID()}@example.com`;
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

function next(courseId: string, cookie?: string) {
  return api.request(`/api/courses/${courseId}/next`, cookie ? { headers: { cookie } } : undefined);
}

function progress(courseId: string, learnerId: string, cookie?: string) {
  return api.request(
    `/api/courses/${courseId}/learners/${learnerId}/progress`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

function postEvidence(
  body: unknown,
  cookie?: string,
  learnerId = learner.id,
  organization = organizationId,
) {
  return api.request(`/api/organizations/${organization}/learners/${learnerId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function activity(courseId: string, cookie?: string) {
  return api.request(
    `/api/courses/${courseId}/activity`,
    cookie ? { headers: { cookie } } : undefined,
  );
}

function postAttempt(
  courseId: string,
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return api.request(`/api/courses/${courseId}/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
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
/**
 * Outside the database gate below, because it needs none: the session lookup
 * throws before the course ID or the database can matter. Why the cache header
 * is each read's first statement, and the whole of why no custom error handler
 * was added — Hono's default 500 keeps the headers already on the context, a
 * claim ADR 0010 makes and this is the only thing that checks.
 */
test("carries the cache header even when the session lookup throws", async () => {
  const broken = createApi({
    database,
    baseUrl,
    auth: {
      api: {
        getSession: () => {
          throw new Error("the database is down");
        },
      },
    } as unknown as typeof auth,
  });

  const response = await broken.request("/api/courses/irrelevant/next");

  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

describe.skipIf(!connectionString)("the HTTP API", () => {
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
      organizationId,
      title: "Spanish",
      objectiveIds: [pastTense],
    });
    emptyCourseId = await createCourse(database, {
      organizationId,
      title: "Not started",
      objectiveIds: [],
    });

    const theirs = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourseId = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Somebody else's",
      objectiveIds: [theirs[0]!],
    });

    pastTenseTask = await testing.createTask(database, {
      organizationId,
      objectiveId: pastTense,
      body: {
        kind: "choice",
        prompt: "Past tense of 'hablar'?",
        options: ["hablé", "hablo"],
        answer: 0,
        explanation: "Preterite.",
      },
      createdAt: at,
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner.id, classmate.id]);
  });

  test("serves Better Auth under its own path", async () => {
    const session = await api.request("/api/auth/get-session", {
      headers: { cookie: learner.cookie },
    });

    expect(await session.json()).toMatchObject({ user: { id: learner.id } });
  });

  test("refuses a request carrying no session", async () => {
    expect((await next(courseId)).status).toBe(401);
  });

  test("keeps Better Auth's own answers out of shared caches", async () => {
    // Mounting Better Auth hands it the routing, not the protections: these
    // answer with one caller's organizations and sessions, under whatever cache
    // header the mount puts there.
    for (const path of ["/api/auth/organization/list", "/api/auth/list-sessions"]) {
      const response = await api.request(path, { headers: { cookie: learner.cookie } });

      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("bounds the bodies Better Auth will accept", async () => {
    // Sign-up is unauthenticated, so without a limit here anyone could make the
    // server buffer and store a body of any size the runtime would tolerate.
    const oversized = await api.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `oversized-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery",
        name: "x".repeat(2_000_000),
      }),
    });

    expect(oversized.status).toBe(413);
  });

  test("marks every answer uncacheable, whatever it answers", async () => {
    // The same URL answers differently per cookie, so a shared cache reusing one
    // learner's decision for another would skip the session check entirely.
    const answered = await next(courseId, learner.cookie);
    const caughtUp = await next(emptyCourseId, learner.cookie);
    const unavailable = await next(foreignCourseId, learner.cookie);
    const refused = await next(courseId);

    // Asserted, so that identical failures could not pass as coverage of
    // different answers.
    expect([answered.status, caughtUp.status, unavailable.status, refused.status]).toEqual([
      200, 204, 404, 401,
    ]);
    for (const response of [answered, caughtUp, unavailable, refused]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("answers the signed-in learner with their next objective", async () => {
    const response = await next(courseId, learner.cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ objectiveId: pastTense, intent: "introduce" });
  });

  test("answers from the session's learner, not from anything in the request", async () => {
    // Same URL, same course, two sessions: only the cookie differs, so a route
    // that took the learner from the path or a query could not tell these apart.
    await recordEvidence(database, learner.id, [
      { id: "api-test-failure", objectiveId: pastTense, outcome: "failure", at },
    ]);

    const mine = await next(courseId, learner.cookie);
    const theirs = await next(courseId, classmate.cookie);

    expect(await mine.json()).toMatchObject({ intent: "reteach" });
    expect(await theirs.json()).toMatchObject({ intent: "introduce" });
  });

  test("serializes each decision as the documented shape", async () => {
    // The wire contract a client is written against. Asserting the key sets
    // rather than only the values is what makes a rename inside `learning`
    // break here instead of quietly reshaping the response.
    const introduce = await (await next(courseId, learner.cookie)).json();

    expect(introduce).toEqual({
      objectiveId: pastTense,
      modelVersion: activeModel.version,
      intent: "introduce",
    });

    await recordEvidence(database, learner.id, [
      { id: "contract-failure", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);
    const reteach = await (await next(courseId, learner.cookie)).json();

    // Also pins Date serialization: the model works in `Date`, the wire does not.
    expect(reteach).toEqual({
      objectiveId: pastTense,
      modelVersion: activeModel.version,
      intent: "reteach",
      lastEvidenceAt: recordedAt.toISOString(),
    });

    await testing.clearLearnerHistory(database, [learner.id]);
    await recordEvidence(database, learner.id, [
      { id: "contract-success", objectiveId: pastTense, outcome: "success", at: recordedAt },
    ]);
    const review = (await (await next(courseId, learner.cookie)).json()) as {
      retrievability: number;
    };

    expect(Object.keys(review).sort()).toEqual([
      "intent",
      "modelVersion",
      "objectiveId",
      "retrievability",
      "stability",
    ]);
    expect(review).toMatchObject({
      objectiveId: pastTense,
      modelVersion: activeModel.version,
      intent: "review",
      stability: 1,
    });
    // A probability rather than a value, since the route reads the real clock.
    expect(review.retrievability).toBeGreaterThan(0);
    expect(review.retrievability).toBeLessThan(1);
  });

  test("records what an admin says a learner did, and answers differently after", async () => {
    // The whole loop over HTTP, and the only thing that moves a learner off
    // `introduce`: without it no other phase of the model is reachable.
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

  test("refuses a forgeable write before it can record anything", async () => {
    // The status alone is covered for every write below; what is checked here is
    // that the refusal comes first, so a forged request never reaches the table.
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

  /**
   * Every Braivo write installs `bodyLimit` and calls `isTrustedWrite` for
   * itself. Explicit calls are simpler than a middleware that would have
   * to exempt the Better Auth mount, which does its own origin check — but
   * duplicated protection needs duplicated coverage, or deleting one of them
   * leaves the suite green.
   *
   * Resolved inside each test rather than in the table, since the learner and
   * the organization only exist once `beforeAll` has run.
   */
  function write(route: "evidence" | "objectives" | "tasks" | "courses" | "attempts") {
    switch (route) {
      case "evidence":
        return {
          path: `/api/organizations/${organizationId}/learners/${learner.id}/evidence`,
          body: graded() as unknown,
          accepted: 204,
        };
      case "objectives":
        return {
          path: `/api/organizations/${organizationId}/objectives`,
          body: { titles: ["Guarded"] } as unknown,
          accepted: 201,
        };
      case "tasks":
        // Empty, so the accepted write adds nothing another test would be offered.
        return {
          path: `/api/organizations/${organizationId}/tasks`,
          body: { tasks: [] } as unknown,
          accepted: 201,
        };
      case "courses":
        return {
          path: `/api/organizations/${organizationId}/courses`,
          body: { title: `Guarded ${crypto.randomUUID()}`, objectiveIds: [] } as unknown,
          accepted: 201,
        };
      case "attempts":
        return {
          path: `/api/courses/${courseId}/attempts`,
          body: {
            id: crypto.randomUUID(),
            taskId: pastTenseTask,
            response: { choice: 0 },
          } as unknown,
          accepted: 200,
        };
    }
  }

  const routes = ["evidence", "objectives", "tasks", "courses", "attempts"] as const;

  test.each(routes)("refuses a forgeable write to %s", async (route) => {
    const { path, body, accepted } = write(route);

    const notJson = await api.request(path, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: teacher.cookie },
      body: JSON.stringify(body),
    });
    const elsewhere = await api.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        cookie: teacher.cookie,
      },
      body: JSON.stringify(body),
    });
    // The same request, differing only in what is being checked, so a route that
    // refused everything could not pass this.
    const ours = await api.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, cookie: teacher.cookie },
      body: JSON.stringify(body),
    });

    expect([notJson.status, elsewhere.status, ours.status]).toEqual([403, 403, accepted]);
  });

  test.each(routes)("bounds the body of a write to %s", async (route) => {
    const oversized = await api.request(write(route).path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ padding: "x".repeat(2_000_000) }),
    });

    // Refused on its size, before anything reads what it says: the body is
    // nonsense, which a route that got to look at it would answer 400 to.
    expect(oversized.status).toBe(413);
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
    // then succeeded. That second answer used to be a 204 that recorded nothing.
    const first = await postEvidence(graded({ outcome: "failure" }), teacher.cookie);
    const second = await postEvidence(graded({ outcome: "success" }), teacher.cookie);

    expect([first.status, second.status]).toEqual([204, 409]);
    // The first result stands, and nothing claims the second one landed.
    expect(await (await next(courseId, learner.cookie)).json()).toMatchObject({
      intent: "reteach",
    });
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

    expect((await post({ tasks: [{ ...task, answer: 2 }] }, teacher.cookie)).status).toBe(400);
    expect((await post({ tasks: [{ ...task, objectiveId: "" }] }, teacher.cookie)).status).toBe(
      400,
    );
    // Well under 1 MB, so refused on its count rather than its size.
    const tooMany = Array.from({ length: 1001 }, () => ({ ...task, answer: 1 }));
    expect((await post({ tasks: tooMany }, teacher.cookie)).status).toBe(400);
    expect((await post({ tasks: [{ ...task, answer: 1 }] }, learner.cookie)).status).toBe(403);
    expect((await post({ tasks: [{ ...task, answer: 1 }] })).status).toBe(401);
  });

  test("lets an admin define objectives and read them back", async () => {
    const created = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ titles: ["  Conditional  ", "Subjunctive"] }),
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
      body: JSON.stringify({ titles: ["Greetings", "Numbers"] }),
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

  test("lists the courses an organization has", async () => {
    const listed = await api.request(`/api/organizations/${organizationId}/courses`, {
      headers: { cookie: teacher.cookie },
    });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      courses: expect.arrayContaining([{ id: courseId, title: "Spanish" }]),
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

  test.each([
    ["no title", { objectiveIds: [] }],
    ["a blank title", { title: "  ", objectiveIds: [] }],
    ["no objectiveIds", { title: "Course" }],
    ["a duplicated objective", { title: "Course", objectiveIds: ["a", "a"] }],
    ["an empty objective id", { title: "Course", objectiveIds: [""] }],
  ])("rejects a course with %s", async (_label, body) => {
    const response = await api.request(`/api/organizations/${organizationId}/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
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

  test("refuses a learner authoring or listing objectives", async () => {
    const defining = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: JSON.stringify({ titles: ["Snuck in"] }),
    });
    const listing = await api.request(`/api/organizations/${organizationId}/objectives`, {
      headers: { cookie: learner.cookie },
    });

    expect([defining.status, listing.status]).toEqual([403, 403]);
  });

  test.each([
    ["titles missing", {}],
    ["titles not an array", { titles: "Conditional" }],
    ["a blank title", { titles: ["   "] }],
    ["a title that is not a string", { titles: [7] }],
  ])("rejects a definition with %s", async (_label, body) => {
    const response = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
  });

  test("answers 404 for a course belonging to another organization", async () => {
    expect((await next(foreignCourseId, learner.cookie)).status).toBe(404);
  });

  test("answers a course that does not exist exactly as it answers one that is not yours", async () => {
    // The disclosure this pair rules out: a 404 that appeared only for courses
    // owned by somebody else would enumerate them one guess at a time.
    const unknown = await next("no-such-course", learner.cookie);
    const foreign = await next(foreignCourseId, learner.cookie);

    expect(unknown.status).toBe(404);
    expect(unknown.status).toBe(foreign.status);
    expect(await unknown.text()).toBe(await foreign.text());
  });

  test("answers 204 to a learner who is caught up, and to nobody else", async () => {
    // The one answer that is safe to tell apart from a 404, because only a
    // member reaches it. A classmate is a member too, so gets it as well; an
    // outsider asking about the same course does not.
    const outsider = await signUp();

    expect((await next(emptyCourseId, learner.cookie)).status).toBe(204);
    expect((await next(emptyCourseId, classmate.cookie)).status).toBe(204);
    expect((await next(emptyCourseId, outsider.cookie)).status).toBe(404);
  });

  test("shows a content owner where a learner stands, in the documented shape", async () => {
    // Pinned field by field, as the decision is: the body is a serialization of
    // `KnowledgeReport`, and a rename inside `learning` would reshape it.
    const unseen = await progress(courseId, learner.id, teacher.cookie);
    expect(unseen.status).toBe(200);
    expect(await unseen.json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [{ objectiveId: pastTense, phase: "unseen" }],
    });

    await recordEvidence(database, learner.id, [
      { id: "progress-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);
    expect(await (await progress(courseId, learner.id, teacher.cookie)).json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [
        { objectiveId: pastTense, phase: "acquiring", lastEvidenceAt: recordedAt.toISOString() },
      ],
    });

    const later = new Date(recordedAt.getTime() + 1000);
    await recordEvidence(database, learner.id, [
      { id: "progress-kept", objectiveId: pastTense, outcome: "success", at: later },
    ]);
    // Retrievability is read off the real clock, so only its type is pinned;
    // a month past a one-day stability is certainly due.
    expect(await (await progress(courseId, learner.id, teacher.cookie)).json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [
        {
          objectiveId: pastTense,
          phase: "retaining",
          lastEvidenceAt: later.toISOString(),
          stability: 1,
          retrievability: expect.any(Number),
          due: true,
        },
      ],
    });
  });

  test("shows a learner's progress to their organization's administrators only", async () => {
    // The learner reading their own is refused too: a member does not
    // administer, and self-service is not what this route is for.
    expect((await progress(courseId, learner.id)).status).toBe(401);
    expect((await progress(courseId, learner.id, learner.cookie)).status).toBe(404);
    expect((await progress(courseId, learner.id, classmate.cookie)).status).toBe(404);
    expect((await progress(courseId, learner.id, teacher.cookie)).status).toBe(200);
  });

  test("answers progress in a course that is not the reader's as in one that does not exist", async () => {
    const unknown = await progress("no-such-course", learner.id, teacher.cookie);
    const foreign = await progress(foreignCourseId, learner.id, teacher.cookie);

    expect(unknown.status).toBe(404);
    expect([foreign.status, await foreign.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  test("answers progress for a learner outside the organization as for an ID nobody has", async () => {
    // A real account, just not one of this organization's: telling it apart from
    // an unused ID would let an administrator test whether an ID exists at all.
    const outsider = await signUp();

    const theirs = await progress(courseId, outsider.id, teacher.cookie);
    const nobodys = await progress(courseId, "nobody-has-this-id", teacher.cookie);

    expect(theirs.status).toBe(404);
    expect([nobodys.status, await nobodys.text()]).toEqual([theirs.status, await theirs.text()]);
  });

  test("marks every progress answer uncacheable, whatever it answers", async () => {
    const answered = await progress(courseId, learner.id, teacher.cookie);
    const refused = await progress(courseId, learner.id, learner.cookie);
    const anonymous = await progress(courseId, learner.id);

    expect([answered.status, refused.status, anonymous.status]).toEqual([200, 404, 401]);
    for (const response of [answered, refused, anonymous]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("lists the courses of every organization the learner is in, and nobody else's", async () => {
    const secondOrganizationId = "api-test-second-org";
    await testing.seedOrganization(database, {
      organizationId: secondOrganizationId,
      learnerIds: [learner.id],
      at,
    });
    const secondCourseId = await createCourse(database, {
      organizationId: secondOrganizationId,
      title: "Portuguese",
      objectiveIds: [],
    });

    const response = await api.request("/api/courses", { headers: { cookie: learner.cookie } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { courses } = (await response.json()) as { courses: { id: string }[] };
    const ids = courses.map((course) => course.id);
    // By title across organizations, the second's between the first's two:
    // Not started, Portuguese, Spanish.
    const ours = [courseId, emptyCourseId, secondCourseId];
    expect(ids.filter((id) => ours.includes(id))).toEqual([
      emptyCourseId,
      secondCourseId,
      courseId,
    ]);
    expect(ids).not.toContain(foreignCourseId);

    const anonymous = await api.request("/api/courses");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
  });

  test("serves the learner a task in the documented shape, never its answer", async () => {
    const response = await activity(courseId, learner.cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      decision: { objectiveId: pastTense, modelVersion: activeModel.version, intent: "introduce" },
      task: {
        id: pastTenseTask,
        kind: "choice",
        prompt: "Past tense of 'hablar'?",
        options: ["hablé", "hablo"],
      },
    });
  });

  test("answers activity as it answers the decision when there is none to give", async () => {
    expect((await activity(courseId)).status).toBe(401);
    expect((await activity(foreignCourseId, learner.cookie)).status).toBe(404);
    expect((await activity(emptyCourseId, learner.cookie)).status).toBe(204);
  });

  test("grades a learner's answer, and the next activity follows from it", async () => {
    const attempt = { id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 1 } };

    const response = await postAttempt(courseId, attempt, learner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "failure",
      answer: 0,
      explanation: "Preterite.",
    });

    // Its only task rests, since the learner was just shown the answer.
    expect(await (await activity(courseId, learner.cookie)).json()).toEqual({
      decision: expect.objectContaining({ intent: "reteach" }),
      retryAfter: 600,
    });
    const again = { ...attempt, id: crypto.randomUUID(), response: { choice: 0 } };
    const early = await postAttempt(courseId, again, learner.cookie);
    expect(early.status).toBe(429);
    expect(Number(early.headers.get("retry-after"))).toBeGreaterThan(590);

    // Resent after a lost answer: the same grade, and no second record.
    expect((await postAttempt(courseId, attempt, learner.cookie)).status).toBe(200);
    expect(await stored(learner.id)).toHaveLength(1);

    const changed = { ...attempt, response: { choice: 0 } };
    expect((await postAttempt(courseId, changed, learner.cookie)).status).toBe(409);
  });

  test("refuses attempts it cannot or must not record, recording none", async () => {
    const attempt = { id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 0 } };

    const refusals = [
      await postAttempt(courseId, attempt),
      await postAttempt(courseId, attempt, learner.cookie, { origin: "https://evil.example.com" }),
      await postAttempt(courseId, { ...attempt, id: "" }, learner.cookie),
      await postAttempt(courseId, { ...attempt, id: "x".repeat(129) }, learner.cookie),
      await postAttempt(courseId, { ...attempt, response: { choice: 5 } }, learner.cookie),
      await postAttempt(foreignCourseId, attempt, learner.cookie),
    ];

    expect(refusals.map((response) => response.status)).toEqual([401, 403, 400, 400, 400, 404]);
    expect(await stored(learner.id)).toEqual([]);
  });
});
