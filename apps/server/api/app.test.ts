// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import { session } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { type Model, ModelUnavailable } from "../ai/index.ts";
import { registerLearnDomain } from "../application/index.ts";
import { createAuth } from "../auth/index.ts";
import { activeModel } from "../learning/index.ts";
import {
  createCourse,
  createObjectives,
  createTasks,
  recordEvidence,
} from "../persistence/index.ts";
import { bucketStore, directoryStore } from "../storage/index.ts";
import { createApi } from "./app.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const stored = (learnerId: string) => testing.readStoredEvidence(database, learnerId);
const auth = createAuth({
  database,
  secret: "api-test-secret-that-is-long-enough-32",
  baseURL: "http://localhost:3000",
});
const baseUrl = "http://localhost:3000";
const api = createApi({ auth, database, baseUrl });

const organizationId = "api-test-org";
const otherOrganizationId = "api-test-other-org";
/** Registered as `organizationId`'s own domain, which serves its learn app. */
const organizationOrigin = "https://api-test.example.com";
/** Registered as `otherOrganizationId`'s. */
const otherOrganizationOrigin = "https://api-test-other.example.com";
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

function courseProgress(courseId: string, cookie?: string) {
  return api.request(
    `/api/courses/${courseId}/progress`,
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

    // Through the operator's use case, so the domain tests below run on
    // registered hostnames. Seeding makes each slug its organization's ID.
    for (const [organizationSlug, origin] of [
      [organizationId, organizationOrigin],
      [otherOrganizationId, otherOrganizationOrigin],
    ] as const) {
      await registerLearnDomain({
        database,
        baseUrl,
        organizationSlug,
        hostname: new URL(origin).hostname,
      });
    }

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
        // So the documented shape can be pinned exactly; shuffling is `content`'s to test.
        keepOrder: true,
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
    // Braivo's own refusal under the mount, so the mount's cache header too.
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
  });

  test("signs nobody up on an organization's domain, or any host but the installation's", async () => {
    const signUpOn = (origin: string) =>
      api.request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `api-test-${crypto.randomUUID()}@example.com`,
          password: "correct horse battery",
          name: "Nobody",
        }),
      });

    const onOrganizationDomain = await signUpOn(organizationOrigin);
    expect(onOrganizationDomain.status).toBe(404);
    expect(onOrganizationDomain.headers.get("cache-control")).toBe("private, no-store");
    expect((await signUpOn("https://api-test-unknown.example.com")).status).toBe(404);
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

  test("lists the organizations someone manages, uncacheably, and only to a session", async () => {
    const list = (cookie?: string) =>
      api.request("/api/organizations", cookie ? { headers: { cookie } } : undefined);

    const managed = await list(teacher.cookie);
    const anonymous = await list();

    expect(await managed.json()).toMatchObject({
      organizations: [{ id: organizationId, slug: organizationId }],
    });
    expect(await (await list(learner.cookie)).json()).toEqual({ organizations: [] });
    expect(anonymous.status).toBe(401);
    for (const response of [managed, anonymous]) {
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
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
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

    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
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
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
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

  test("refuses an evidence ID too long to index as a bad request", async () => {
    const response = await postEvidence(graded({ id: "x".repeat(257) }), teacher.cookie);

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
  function write(route: "evidence" | "objectives" | "tasks" | "retire" | "courses" | "attempts") {
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
          body: { objectives: [{ title: "Guarded" }] } as unknown,
          accepted: 201,
        };
      case "tasks":
        // Empty, so the accepted write adds nothing another test would be offered.
        return {
          path: `/api/organizations/${organizationId}/tasks`,
          body: { tasks: [] } as unknown,
          accepted: 201,
        };
      case "retire":
        return {
          path: `/api/organizations/${organizationId}/tasks/retire`,
          body: { taskIds: [] } as unknown,
          accepted: 204,
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

  const routes = ["evidence", "objectives", "tasks", "retire", "courses", "attempts"] as const;

  test("names the organization the request's host serves, and nothing for other hosts", async () => {
    const served = await api.request(`${organizationOrigin}/api/organization`);
    const unserved = await api.request(`${baseUrl}/api/organization`);

    expect(served.status).toBe(200);
    // `seedOrganization` names an organization after its ID.
    expect(await served.json()).toEqual({ name: organizationId });
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(unserved.status).toBe(404);
  });

  test("answers a course on its own organization's domain and the installation's, and 404 elsewhere", async () => {
    const on = (origin: string) =>
      api.request(`${origin}/api/courses/${courseId}/next`, {
        headers: { cookie: learner.cookie },
      });

    expect((await on(organizationOrigin)).status).toBe(200);
    expect((await on(baseUrl)).status).toBe(200);
    expect((await on(otherOrganizationOrigin)).status).toBe(404);
    expect((await on("https://api-test-unknown.example.com")).status).toBe(404);
  });

  test("answers a course's overview on the same hosts only", async () => {
    // It lists the organization's members, so a host it leaks to learns who they are.
    const on = (origin: string) =>
      api.request(`${origin}/api/courses/${courseId}/progress`, {
        headers: { cookie: teacher.cookie },
      });

    expect((await on(organizationOrigin)).status).toBe(200);
    expect((await on(baseUrl)).status).toBe(200);
    expect((await on(otherOrganizationOrigin)).status).toBe(404);
    expect((await on("https://api-test-unknown.example.com")).status).toBe(404);
  });

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
    // A learn domain writes only to itself, and only as a learner: the
    // console's API is not there.
    const fromDomain = (url: string) =>
      api.request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: organizationOrigin,
          cookie: teacher.cookie,
        },
        body: JSON.stringify(body),
      });
    const sideways = await fromDomain(path);
    const onDomain = await fromDomain(`${organizationOrigin}${path}`);

    expect([notJson.status, elsewhere.status, ours.status, sideways.status]).toEqual([
      403,
      403,
      accepted,
      403,
    ]);
    expect(onDomain.status).toBe(route === "attempts" ? accepted : 404);
  });

  test("keeps the console's API and an account's tools on the installation's host", async () => {
    const sources = `/api/organizations/${organizationId}/sources`;
    const at = (origin: string, path: string, headers: Record<string, string> = {}) =>
      api.request(`${origin}${path}`, { headers: { cookie: teacher.cookie, ...headers } });

    expect((await at(baseUrl, sources)).status).toBe(200);
    expect((await at(organizationOrigin, sources)).status).toBe(404);
    expect((await at(organizationOrigin, "/api/organizations")).status).toBe(404);
    const device = await api.request(`${organizationOrigin}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "braivo-cli" }),
    });
    expect(device.status).toBe(404);
    // A token is refused before anything reads it, a learner's route included.
    const bearer = { authorization: "Bearer anything" };
    expect((await at(organizationOrigin, `/api/courses/${courseId}/next`, bearer)).status).toBe(
      401,
    );
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
    // Each quote is a scan of its source, so a request finds at most 200.
    const quoting = Array.from({ length: 21 }, () => ({
      ...task,
      citations: Array.from({ length: 10 }, () => ({ sourceId: "s", quote: "q" })),
    }));
    expect((await post({ tasks: quoting }, teacher.cookie)).status).toBe(400);
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
    ["a title carrying a NUL", { title: "Course\u0000", objectiveIds: [] }],
    ["a title past 500 characters", { title: "C".repeat(501), objectiveIds: [] }],
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
    ["objectives missing", {}],
    ["objectives not an array", { objectives: "Conditional" }],
    ["a bare title", { objectives: ["Conditional"] }],
    ["a blank title", { objectives: [{ title: "   " }] }],
    ["a title with an unpaired surrogate", { objectives: [{ title: "Past \ud800" }] }],
    ["a title past 500 characters", { objectives: [{ title: "P".repeat(501) }] }],
    ["a title that is not a string", { objectives: [{ title: 7 }] }],
    ["a key that is not a string", { objectives: [{ title: "Conditional", key: 7 }] }],
  ])("rejects a definition with %s", async (_label, body) => {
    const response = await api.request(`/api/organizations/${organizationId}/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
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
    // Unique per run, since keys outlive the test in this organization.
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

    const course = { title: "Colores", objectiveIds: [colors], key: `api-${run}/colores` };
    const created = await create(course);
    const recreated = await create(course);
    const reordered = await create({ ...course, objectiveIds: [] });

    expect(await recreated.json()).toEqual(await created.json());
    expect(reordered.status).toBe(409);
    expect(await reordered.json()).toMatchObject({ error: expect.stringContaining("The course") });
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
    // Pinned field by field, as the decision is: the body serializes
    // `LearnerProgressReport`, and a rename inside `learning` would reshape it.
    const unseen = await progress(courseId, learner.id, teacher.cookie);
    expect(unseen.status).toBe(200);
    expect(await unseen.json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [{ objectiveId: pastTense, title: "Past tense", phase: "unseen" }],
    });

    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "progress-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);
    expect(await (await progress(courseId, learner.id, teacher.cookie)).json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [
        {
          objectiveId: pastTense,
          title: "Past tense",
          phase: "acquiring",
          lastEvidenceAt: recordedAt.toISOString(),
        },
      ],
    });

    const later = new Date(recordedAt.getTime() + 1000);
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "progress-kept", objectiveId: pastTense, outcome: "success", at: later },
    ]);
    // Retrievability is read off the real clock, so only its type is pinned;
    // a month past a one-day stability is certainly due.
    expect(await (await progress(courseId, learner.id, teacher.cookie)).json()).toEqual({
      modelVersion: activeModel.version,
      objectives: [
        {
          objectiveId: pastTense,
          title: "Past tense",
          phase: "retaining",
          lastEvidenceAt: later.toISOString(),
          stability: 1,
          retrievability: expect.any(Number),
          due: true,
        },
      ],
    });
  });

  test("shows a learner's progress to them and their organization's administrators only", async () => {
    expect((await progress(courseId, learner.id)).status).toBe(401);
    expect((await progress(courseId, learner.id, learner.cookie)).status).toBe(200);
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
    const refused = await progress(courseId, learner.id, classmate.cookie);
    const anonymous = await progress(courseId, learner.id);

    expect([answered.status, refused.status, anonymous.status]).toEqual([200, 404, 401]);
    for (const response of [answered, refused, anonymous]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("shows a content owner each learner's standings in a course, in the documented shape", async () => {
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "overview-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);

    const response = await courseProgress(courseId, teacher.cookie);
    expect(response.status).toBe(200);
    // Exact at the top, so no field joins unnoticed; other tests add members.
    expect(await response.json()).toEqual({
      modelVersion: activeModel.version,
      learners: expect.arrayContaining([
        {
          userId: learner.id,
          name: expect.any(String),
          roles: ["member"],
          standings: { unseen: 0, acquiring: 1, retained: 0, due: 0 },
        },
      ]),
    });
  });

  test("shows a course's progress to its organization's administrators only, uncacheable", async () => {
    const answered = await courseProgress(courseId, teacher.cookie);
    const learners = await courseProgress(courseId, learner.cookie);
    const anonymous = await courseProgress(courseId);
    const unknown = await courseProgress("no-such-course", teacher.cookie);
    const foreign = await courseProgress(foreignCourseId, teacher.cookie);

    expect([answered, learners, anonymous].map(({ status }) => status)).toEqual([200, 404, 401]);
    expect([foreign.status, await foreign.text()]).toEqual([unknown.status, await unknown.text()]);
    for (const response of [answered, learners, anonymous, unknown]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("lists the courses of every organization the learner is in, and on a domain only its own", async () => {
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

    // On an organization's domain, that organization's alone; elsewhere, none.
    const on = async (origin: string) => {
      const answer = await api.request(`${origin}/api/courses`, {
        headers: { cookie: learner.cookie },
      });
      return ((await answer.json()) as { courses: { id: string }[] }).courses.map(({ id }) => id);
    };
    const onDomain = await on(organizationOrigin);
    expect(onDomain).toContain(courseId);
    expect(onDomain).not.toContain(secondCourseId);
    expect(await on("https://api-test-unknown.example.com")).toEqual([]);

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
      objective: { id: pastTense, title: "Past tense" },
      task: {
        id: pastTenseTask,
        kind: "choice",
        prompt: "Past tense of 'hablar'?",
        options: [
          { choice: 0, text: "hablé" },
          { choice: 1, text: "hablo" },
        ],
      },
    });
  });

  test("answers activity as it answers the decision when there is none to give", async () => {
    expect((await activity(courseId)).status).toBe(401);
    expect((await activity(foreignCourseId, learner.cookie)).status).toBe(404);
    expect((await activity(emptyCourseId, learner.cookie)).status).toBe(204);
  });

  test("answers the decision without a task when its objective has none", async () => {
    const [untaught] = await createObjectives(database, organizationId, ["Untaught"]);
    const untaughtCourseId = await createCourse(database, {
      organizationId,
      title: "Untaught",
      objectiveIds: [untaught!],
    });

    const response = await activity(untaughtCourseId, learner.cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      decision: { objectiveId: untaught, modelVersion: activeModel.version, intent: "introduce" },
      objective: { id: untaught, title: "Untaught" },
    });
  });

  test("grades a learner's answer, and the next activity follows from it", async () => {
    const attempt = { id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 1 } };

    const response = await postAttempt(courseId, attempt, learner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "failure",
      correctChoice: 0,
      explanation: "Preterite.",
    });

    // Its only task rests, since the learner was just shown the answer.
    // Whole seconds; the exact boundary is the application tests'.
    const { objective, retryAfter } = (await (await activity(courseId, learner.cookie)).json()) as {
      objective: unknown;
      retryAfter: number;
    };
    expect(objective).toEqual({ id: pastTense, title: "Past tense" });
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
    // Refused as a conflict, not a 429, whose `Retry-After` would invite
    // resending this very answer once the rest is over.
    const again = { ...attempt, id: crypto.randomUUID(), response: { choice: 0 } };
    const early = await postAttempt(courseId, again, learner.cookie);
    expect(early.status).toBe(409);
    expect(early.headers.get("retry-after")).toBeNull();

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

  /** The same app with somewhere to keep files, which `api` has not. */
  const filed = createApi({
    auth,
    database,
    baseUrl,
    files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-api-files-"))),
  });

  /**
   * An S3-compatible bucket on this machine, as much of one as Bun's client
   * uses — PUT, HEAD, GET by path — so the bucket store runs for real.
   */
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const bucket = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(key, { bytes, type: request.headers.get("content-type") ?? "" });
        return new Response(null, { headers: { etag: '"stored"' } });
      }
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : object.bytes, {
        headers: { "content-type": object.type, "content-length": String(object.bytes.length) },
      });
    },
  });
  afterAll(() => bucket.stop(true));
  const bucketed = createApi({
    auth,
    database,
    baseUrl,
    files: bucketStore(
      new Bun.S3Client({
        bucket: "braivo",
        endpoint: bucket.url.origin,
        accessKeyId: "test",
        secretAccessKey: "test",
      }),
    ),
  });

  function postFile(body: string | Uint8Array, headers: Record<string, string>, app = filed) {
    return app.request(`/api/organizations/${organizationId}/files`, {
      method: "POST",
      headers,
      body,
    });
  }

  function getFile(fileId: string, cookie: string, app = filed) {
    return app.request(`/api/organizations/${organizationId}/files/${fileId}`, {
      headers: { cookie },
    });
  }

  test.each([
    ["a directory", filed],
    ["an S3-compatible bucket", bucketed],
  ])("keeps an uploaded file in %s, and gives it back only as a download", async (_label, app) => {
    const pdf = "%PDF-1.7 Mi primer libro";
    const uploaded = await postFile(
      pdf,
      { "content-type": "Application/PDF; name=libro.pdf", cookie: teacher.cookie },
      app,
    );

    expect(uploaded.status).toBe(201);
    const fileId = new Bun.CryptoHasher("sha256").update(pdf).digest("hex");
    expect(await uploaded.json()).toEqual({ fileId, contentType: "application/pdf", size: 24 });

    const downloaded = await getFile(fileId, teacher.cookie, app);
    expect(downloaded.status).toBe(200);
    expect(Object.fromEntries(downloaded.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": "attachment",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(await downloaded.text()).toBe(pdf);
  });

  test("puts back bytes a store lost when the same file is uploaded again", async () => {
    const pdf = "%PDF-1.7 Perdido";
    const headers = { "content-type": "application/pdf", cookie: teacher.cookie };
    const { fileId } = (await (await postFile(pdf, headers)).json()) as { fileId: string };

    // Another, empty store, as after moving to a new bucket.
    const moved = createApi({
      auth,
      database,
      baseUrl,
      files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-api-files-"))),
    });
    expect((await getFile(fileId, teacher.cookie, moved)).status).toBe(500);

    await postFile(pdf, headers, moved);
    expect(await (await getFile(fileId, teacher.cookie, moved)).text()).toBe(pdf);
  });

  test("takes the type the same bytes were last uploaded as, so a wrong one can be fixed", async () => {
    const pdf = "%PDF-1.7 Sin tipo";
    const as = (type: string) => postFile(pdf, { "content-type": type, cookie: teacher.cookie });
    const { fileId } = (await (await as("application/octet-stream")).json()) as {
      fileId: string;
    };

    expect(await (await as("application/pdf")).json()).toMatchObject({
      fileId,
      contentType: "application/pdf",
    });
    expect((await getFile(fileId, teacher.cookie)).headers.get("content-type")).toBe(
      "application/pdf",
    );
  });

  test.each([
    ["a form's content type", { "content-type": "multipart/form-data; boundary=x" }],
    ["text a page could send", { "content-type": "text/plain" }],
    ["no content type", {}],
    [
      "another site's origin",
      { "content-type": "application/pdf", origin: "https://evil.example" },
    ],
  ])("refuses an upload with %s, which a page elsewhere could make", async (_label, headers) => {
    const refused = await postFile("%PDF", { ...headers, cookie: teacher.cookie });

    expect(refused.status).toBe(403);
  });

  test("keeps files from a learner, who administers nothing", async () => {
    const pdf = { "content-type": "application/pdf" };
    const upload = await postFile("%PDF learner", { ...pdf, cookie: learner.cookie });
    expect(upload.status).toBe(403);

    const kept = await postFile("%PDF kept", { ...pdf, cookie: teacher.cookie });
    const { fileId } = (await kept.json()) as { fileId: string };
    expect((await getFile(fileId, learner.cookie)).status).toBe(403);
  });

  test.each([
    ["a file it does not have", "0".repeat(64)],
    ["what is not a file's ID", "../secrets"],
  ])("answers 404 for %s", async (_label, fileId) => {
    expect((await getFile(fileId, teacher.cookie)).status).toBe(404);
  });

  test("explains an upload it cannot keep", async () => {
    const empty = await postFile(new Uint8Array(), {
      "content-type": "application/pdf",
      cookie: teacher.cookie,
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "The file is empty." });

    const nowhere = await postFile(
      "%PDF",
      {
        "content-type": "application/pdf",
        cookie: teacher.cookie,
      },
      api,
    );
    expect(nowhere.status).toBe(501);
    expect(await nowhere.json()).toEqual({
      error: "This Braivo installation stores no files: its operator has not set BRAIVO_FILES.",
    });
  });

  function postSource(body: unknown, cookie: string, headers: Record<string, string> = {}) {
    return api.request(`/api/organizations/${organizationId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...headers },
      body: JSON.stringify(body),
    });
  }

  test("lets an admin add a source and read it back, in the documented shapes", async () => {
    const added = await postSource({ title: "Unidad 1", text: "Hola\r\nAdiós" }, teacher.cookie);
    const { sourceId } = (await added.json()) as { sourceId: string };

    const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
      headers: { cookie: teacher.cookie },
    });
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    const missing = await api.request(`/api/organizations/${organizationId}/sources/nope`, {
      headers: { cookie: teacher.cookie },
    });

    expect(added.status).toBe(201);
    expect(await listed.json()).toMatchObject({
      sources: expect.arrayContaining([
        { id: sourceId, title: "Unidad 1", createdAt: expect.any(String) },
      ]),
    });
    expect(await read.json()).toEqual({
      id: sourceId,
      title: "Unidad 1",
      text: "Hola\nAdiós",
      createdAt: expect.any(String),
    });
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(missing.status).toBe(404);
  });

  test("keeps a video's link and language beside its transcript", async () => {
    const added = await postSource(
      {
        title: "Los saludos",
        text: "Hola, ¿qué tal?",
        url: "https://www.youtube.com/watch?v=abc123",
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };

    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });

    expect(await read.json()).toEqual({
      id: sourceId,
      title: "Los saludos",
      text: "Hola, ¿qué tal?",
      url: "https://www.youtube.com/watch?v=abc123",
      language: "es",
      createdAt: expect.any(String),
    });
  });

  test("refuses sources it cannot or must not store", async () => {
    const source = { title: "Unidad 1", text: "Hola" };

    const refusals = [
      await postSource(source, learner.cookie),
      await postSource(source, teacher.cookie, { origin: "https://evil.example.com" }),
      await postSource({ title: "Unidad 1" }, teacher.cookie),
      await postSource({ ...source, text: "  " }, teacher.cookie),
      await postSource({ ...source, text: "x".repeat(10_000_001) }, teacher.cookie),
      await postSource({ ...source, url: null }, teacher.cookie),
      await postSource({ ...source, url: "file:///etc/passwd" }, teacher.cookie),
      await postSource({ ...source, language: 7 }, teacher.cookie),
    ];
    const listing = await api.request(`/api/organizations/${organizationId}/sources`, {
      headers: { cookie: learner.cookie },
    });

    expect(refusals.map((response) => response.status)).toEqual([
      403, 403, 400, 400, 413, 400, 400, 400,
    ]);
    expect(listing.status).toBe(403);
  });

  test("takes a learner to the moment of a video a passage is said at", async () => {
    const [animals] = await createObjectives(database, organizationId, ["Animals"]);
    const animalsCourse = await createCourse(database, {
      organizationId,
      title: "Animals",
      objectiveIds: [animals!],
    });
    const video = "https://www.youtube.com/watch?v=animales";

    // A video's captions rather than text: Braivo builds the transcript.
    const added = await postSource(
      {
        title: "Los animales",
        cues: [
          { at: 0, text: "Hola, amigos." },
          { at: 62.5, text: "El perro dice guau." },
        ],
        url: video,
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    expect(await read.json()).toMatchObject({
      text: "Hola, amigos.\nEl perro dice guau.",
      timing: [
        { start: 0, at: 0 },
        { start: 14, at: 62.5 },
      ],
    });

    const authored = await api.request(`/api/organizations/${organizationId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        tasks: [
          {
            objectiveId: animals,
            kind: "choice",
            prompt: "¿Qué dice el perro?",
            options: ["guau", "miau"],
            answer: 0,
            citations: [{ sourceId, quote: "El perro dice guau." }],
          },
        ],
      }),
    });
    const [taskId] = ((await authored.json()) as { taskIds: string[] }).taskIds;
    const answered = await postAttempt(
      animalsCourse,
      { id: crypto.randomUUID(), taskId, response: { choice: 1 } },
      learner.cookie,
    );

    expect(await answered.json()).toMatchObject({
      passages: [
        { quote: "El perro dice guau.", at: 62.5, source: { title: "Los animales", url: video } },
      ],
    });
  });

  test("tells a learner which page of their book a passage is on", async () => {
    const [colors] = await createObjectives(database, organizationId, ["Colors"]);
    const colorsCourse = await createCourse(database, {
      organizationId,
      title: "Colors",
      objectiveIds: [colors!],
    });

    // A book's pages rather than text, each labelled as printed.
    const added = await postSource(
      {
        title: "Mi primer libro",
        pages: [
          { page: "11", text: "Los colores" },
          { page: "12", text: "Rojo significa red." },
        ],
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    expect(await read.json()).toMatchObject({
      text: "Los colores\n\nRojo significa red.",
      pagination: [
        { start: 0, page: "11" },
        { start: 13, page: "12" },
      ],
    });

    const authored = await api.request(`/api/organizations/${organizationId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        tasks: [
          {
            objectiveId: colors,
            kind: "choice",
            prompt: "¿Qué significa rojo?",
            options: ["red", "blue"],
            answer: 0,
            citations: [{ sourceId, quote: "Rojo significa red." }],
          },
        ],
      }),
    });
    const [taskId] = ((await authored.json()) as { taskIds: string[] }).taskIds;
    const answered = await postAttempt(
      colorsCourse,
      { id: crypto.randomUUID(), taskId, response: { choice: 1 } },
      learner.cookie,
    );

    expect(await answered.json()).toMatchObject({
      passages: [
        { quote: "Rojo significa red.", page: "12", source: { title: "Mi primer libro" } },
      ],
    });
  });

  test.each([
    [
      "both cues and pages",
      { cues: [{ at: 0, text: "Hola" }], pages: [{ page: "1", text: "Hola" }] },
      undefined,
    ],
    ["a page numbered rather than labelled", { pages: [{ page: 1, text: "Hola" }] }, undefined],
    [
      "a page without words",
      { pages: [{ page: "1", text: " " }] },
      "Page 0 has no text Braivo can store: it is blank, or carries a NUL or an unpaired surrogate; leave out a page without words.",
    ],
  ])("refuses a document with %s", async (_label, body, error) => {
    const refused = await postSource({ title: "Book", ...body }, teacher.cookie);

    expect(refused.status).toBe(400);
    if (error === undefined) expect(await refused.text()).toBe("");
    else expect(await refused.json()).toEqual({ error });
  });

  test.each([
    ["both text and cues", { text: "Hola", cues: [{ at: 0, text: "Hola" }] }, undefined],
    ["a cue without a time", { cues: [{ text: "Hola" }] }, undefined],
    [
      "cues out of order",
      {
        cues: [
          { at: 5, text: "Hola" },
          { at: 1, text: "Adiós" },
        ],
      },
      "Cue 1 starts before the cue before it; send cues in order.",
    ],
  ])("refuses a transcript with %s", async (_label, body, error) => {
    const refused = await postSource({ title: "Transcript", ...body }, teacher.cookie);

    expect(refused.status).toBe(400);
    // Malformed bodies answer bare; a transcript refused for what it says explains.
    if (error === undefined) expect(await refused.text()).toBe("");
    else expect(await refused.json()).toEqual({ error });
  });

  test("drafts a course from a source with the installation's model, storing nothing", async () => {
    const added = await postSource(
      { title: "Saludos", text: "Hola significa hello." },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const asked: string[] = [];
    const model: Model = {
      answer: async ({ prompt }) => {
        asked.push(prompt);
        return {
          objectives: [
            {
              title: "Say hello",
              quotes: ["Hola significa hello."],
              tasks: [
                {
                  prompt: "Hello?",
                  options: ["Hola", "Adiós"],
                  answer: 0,
                  quotes: ["Hola significa hello."],
                },
                {
                  prompt: "Hola?",
                  options: ["Hello", "Goodbye"],
                  answer: 0,
                  quotes: ["Hola significa hola."],
                },
              ],
            },
          ],
        };
      },
    };
    const drafting = createApi({
      auth,
      database,
      baseUrl,
      ai: { model, organizations: new Set([organizationId]) },
    });
    const draft = (source: string, cookie: string, body: object = {}, app = drafting) =>
      app.request(`/api/organizations/${organizationId}/sources/${source}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    const drafted = await draft(sourceId, teacher.cookie, { audience: "grade 2" });
    expect(drafted.status).toBe(200);
    expect(await drafted.json()).toEqual({
      objectives: [
        {
          key: expect.any(String),
          title: "Say hello",
          citations: [{ sourceId, quote: "Hola significa hello." }],
          tasks: [
            {
              kind: "choice",
              prompt: "Hello?",
              options: ["Hola", "Adiós"],
              answer: 0,
              citations: [{ sourceId, quote: "Hola significa hello." }],
            },
          ],
        },
      ],
      refused: [
        "Objective 0, task 1, quote 0: the quote does not occur in the source.",
        "Objective 0, task 1: none of its quotes was found in the source.",
      ],
    });
    expect(asked[0]).toContain("Learners: grade 2.");

    // Served by Bun, the request is let wait for the model past Bun's idle timeout.
    const timeout = vi.fn();
    await drafting.request(
      `/api/organizations/${organizationId}/sources/${sourceId}/draft`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      },
      { timeout },
    );
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);

    // Nobody but an administrator spends the installation's model.
    expect((await draft(sourceId, learner.cookie)).status).toBe(403);
    expect((await draft(crypto.randomUUID(), teacher.cookie)).status).toBe(404);
    const long = await draft(sourceId, teacher.cookie, { audience: "a".repeat(201) });
    expect(long.status).toBe(400);
    // Owning an organization is not the operator's leave to spend on it.
    const elsewhere = createApi({
      auth,
      database,
      baseUrl,
      ai: { model, organizations: new Set(["another-org"]) },
    });
    const refused = await draft(sourceId, teacher.cookie, {}, elsewhere);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("ask its operator");
    expect(asked).toHaveLength(2);
  });

  test("reads a PDF's text, page by page, for an organization the operator lets", async () => {
    const files = directoryStore(mkdtempSync(join(tmpdir(), "braivo-api-files-")));
    const model: Model = {
      answer: async ({ files: read }) => ({
        pages: [{ page: "1", text: `Leído: ${new TextDecoder().decode(read?.[0]?.bytes)}` }],
      }),
    };
    const reading = createApi({
      auth,
      database,
      baseUrl,
      files,
      ai: { model, organizations: new Set([organizationId]) },
    });
    const upload = async (body: string, type: string) => {
      const uploaded = await postFile(
        body,
        { "content-type": type, cookie: teacher.cookie },
        reading,
      );
      return ((await uploaded.json()) as { fileId: string }).fileId;
    };
    const read = (fileId: string, app = reading) =>
      app.request(`/api/organizations/${organizationId}/files/${fileId}/text`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    const pdf = await upload("%PDF-1.7 Hola", "application/pdf");
    const answered = await read(pdf);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ pages: [{ page: "1", text: "Leído: %PDF-1.7 Hola" }] });

    const epub = await upload("PK epub", "application/epub+zip");
    const refused = await read(epub);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("reads PDFs and images");
    expect((await read("0".repeat(64))).status).toBe(404);
    // No file store: nothing to read from, said as for uploading.
    expect(
      (await read(pdf, createApi({ auth, database, baseUrl, ai: { model, organizations: "all" } })))
        .status,
    ).toBe(501);
  });

  test("stops an organization at its month's AI requests, counting only those asked", async () => {
    // An organization of its own, so no other test's requests count against it.
    const limitedOrganization = "api-test-limited-org";
    await testing.seedOrganization(database, {
      organizationId: limitedOrganization,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });
    const added = await api.request(`/api/organizations/${limitedOrganization}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({ title: "Saludos", text: "Hola significa hello." }),
    });
    const { sourceId } = (await added.json()) as { sourceId: string };
    let asked = 0;
    const limited = createApi({
      auth,
      database,
      baseUrl,
      ai: {
        model: {
          answer: async () => {
            asked += 1;
            return { objectives: [] };
          },
        },
        organizations: "all",
        monthlyLimit: 1,
      },
    });
    const draft = (body: object = {}) =>
      limited.request(`/api/organizations/${limitedOrganization}/sources/${sourceId}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify(body),
      });

    // Refused before the model is asked, so it costs nothing.
    expect((await draft({ audience: "a".repeat(201) })).status).toBe(400);
    expect((await draft()).status).toBe(200);

    const refused = await draft();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^This organization has used its 1 AI requests for this month; more from \d{4}-\d{2}-01/,
    );
    expect(asked).toBe(1);
  });

  test("charges nothing for a file the store failed to give", async () => {
    const readOrganization = "api-test-read-org";
    await testing.seedOrganization(database, {
      organizationId: readOrganization,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });
    const store = directoryStore(mkdtempSync(join(tmpdir(), "braivo-api-files-")));
    let failing = false;
    const reading = createApi({
      auth,
      database,
      baseUrl,
      files: {
        put: (key, bytes, type) => store.put(key, bytes, type),
        // As a bucket's lazy file does: found, and then failing to download.
        get: async (key) =>
          failing
            ? ({ arrayBuffer: () => Promise.reject(new Error("download failed")) } as Blob)
            : store.get(key),
      },
      ai: {
        model: { answer: async () => ({ pages: [{ page: "1", text: "Hola." }] }) },
        organizations: "all",
        monthlyLimit: 1,
      },
    });
    const uploaded = await reading.request(`/api/organizations/${readOrganization}/files`, {
      method: "POST",
      headers: { "content-type": "application/pdf", cookie: teacher.cookie },
      body: "%PDF-1.7 Hola",
    });
    const { fileId } = (await uploaded.json()) as { fileId: string };
    const read = () =>
      reading.request(`/api/organizations/${readOrganization}/files/${fileId}/text`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    failing = true;
    expect((await read()).status).toBe(500);
    failing = false;
    // The month's one request is still there to use.
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(429);
  });

  test("says why it cannot draft: no model, or a model that failed", async () => {
    const added = await postSource(
      { title: "Saludos", text: "Hola significa hello." },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const failing = createApi({
      auth,
      database,
      baseUrl,
      ai: {
        model: {
          answer: async () => {
            throw new ModelUnavailable("The model answered 529.");
          },
        },
        organizations: "all",
      },
    });
    const draft = (app: typeof api) =>
      app.request(`/api/organizations/${organizationId}/sources/${sourceId}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    const none = await draft(api);
    expect(none.status).toBe(501);
    expect(((await none.json()) as { error: string }).error).toContain("braivo mcp");
    const failed = await draft(failing);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "The model answered 529." });
  });

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
    );
    const colors = await createCourse(database, {
      organizationId,
      title: "Colores",
      objectiveIds: [blue!, red!],
    });
    const read = (courseId: string, cookie: string, organization = organizationId) =>
      api.request(`/api/organizations/${organization}/courses/${courseId}`, {
        headers: { cookie },
      });

    const course = await read(colors, teacher.cookie);
    expect(course.status).toBe(200);
    expect(await course.json()).toEqual({
      id: colors,
      title: "Colores",
      objectives: [
        { id: blue, title: "Blue", citations: [], tasks: [] },
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
            },
          ],
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

    const cite = (quote: string, cookie = teacher.cookie) =>
      api.request(`/api/organizations/${organizationId}/citations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ citations: [{ objectiveId, sourceId, quote }] }),
      });

    const cited = await cite("uno, dos, tres.");
    const invented = await cite("cuatro, cinco");
    const byLearner = await cite("uno, dos, tres.", learner.cookie);
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
    expect(await read.json()).toEqual({
      citations: [{ sourceId, start: 13, end: 28, quote: "uno, dos, tres." }],
    });
    expect(read.headers.get("cache-control")).toBe("private, no-store");
  });

  describe("a content owner's own tools, signed in through the device flow", () => {
    /** What Braivo's CLI sends: JSON, and no cookie, ever. */
    function asCli(path: string, body: Record<string, string>) {
      return api.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    const token = (deviceCode: string) =>
      asCli("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "braivo-cli",
      });

    async function requestCode() {
      const requested = await asCli("/api/auth/device/code", { client_id: "braivo-cli" });
      return (await requested.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
      };
    }

    test("sends the content owner to the console's approval page, code included", async () => {
      const { user_code, verification_uri, verification_uri_complete } = await requestCode();

      expect(verification_uri).toBe(`${baseUrl}/device`);
      const complete = new URL(verification_uri_complete);
      expect(complete.pathname).toBe("/device");
      expect(complete.searchParams.get("user_code")).toBe(user_code);
    });

    test("leaves polling for a token to the device flow's own pacing", () => {
      // Better Auth limits only in production, so the rule is what can be
      // checked here: its generic limit would cut a polling CLI off before its
      // code expires, while the flow answers `slow_down` per code by itself.
      expect(auth.options.rateLimit?.customRules?.["/device/token"]).toBe(false);
    });

    /** The content owner, in their signed-in browser, entering the code the CLI showed. */
    async function approve(userCode: string, cookie = teacher.cookie) {
      await api.request(`/api/auth/device?user_code=${userCode}`, { headers: { cookie } });
      return api.request("/api/auth/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: baseUrl },
        body: JSON.stringify({ userCode }),
      });
    }

    test("acts as the content owner who approved it, over the same API", async () => {
      // Not yet, for a code nobody has approved. A code of its own: polling one
      // twice within its interval answers `slow_down`, as the device flow says.
      const unapproved = await requestCode();
      const pending = await token(unapproved.device_code);
      expect(pending.status).toBe(400);
      expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

      const { device_code, user_code } = await requestCode();
      expect((await approve(user_code)).status).toBe(200);
      const issued = await token(device_code);
      const { access_token } = (await issued.json()) as { access_token: string };
      expect(issued.status).toBe(200);

      const bearer = {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      };
      const added = await api.request(`/api/organizations/${organizationId}/sources`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ title: "Transcript", text: "Hola.", language: "es" }),
      });
      const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: { authorization: `Bearer ${access_token}` },
      });

      expect(added.status).toBe(201);
      expect(listed.status).toBe(200);
      // A code is exchanged once.
      expect((await token(device_code)).status).toBe(400);

      // It finds its way, and manages nothing: approving another code takes the
      // person in their browser.
      const found = await api.request("/api/auth/get-session", {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(found.status).toBe(200);
      const another = await requestCode();
      const approving = await api.request("/api/auth/device/approve", {
        method: "POST",
        headers: { ...bearer, origin: baseUrl },
        body: JSON.stringify({ userCode: another.user_code }),
      });
      expect(approving.status).toBe(403);
    });

    test("renews a token's session without handing it a cookie", async () => {
      const { device_code, user_code } = await requestCode();
      await approve(user_code);
      const { access_token } = (await (await token(device_code)).json()) as {
        access_token: string;
      };
      // Due for renewal, as after a day in use.
      await database
        .update(session)
        .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
        .where(eq(session.token, access_token));
      const bearer = { authorization: `Bearer ${access_token}` };

      const found = await api.request("/api/auth/get-session", { headers: bearer });
      const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: bearer,
      });

      expect([found.status, listed.status]).toEqual([200, 200]);
      expect(found.headers.getSetCookie()).toEqual([]);
      expect(found.headers.get("set-auth-token")).toBeNull();
      expect(listed.headers.getSetCookie()).toEqual([]);
    });

    test("carries the approver's roles, not more", async () => {
      // A learner can approve a code for themselves, and the token is a learner.
      const { device_code, user_code } = await requestCode();
      await approve(user_code, learner.cookie);
      const { access_token } = (await (await token(device_code)).json()) as {
        access_token: string;
      };

      const refused = await api.request(`/api/organizations/${organizationId}/sources`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Snuck in", text: "Hola." }),
      });

      expect(refused.status).toBe(403);
    });

    test("refuses a client Braivo does not know, and a token nobody issued", async () => {
      const unknown = await asCli("/api/auth/device/code", { client_id: "some-other-app" });
      const forged = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: { authorization: "Bearer not-a-session" },
      });

      expect(unknown.status).toBe(400);
      expect(forged.status).toBe(401);
    });
  });
});
