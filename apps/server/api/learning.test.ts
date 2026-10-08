// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The learning routes (`learning.ts`): a learner's courses, what to do next in
// one, its tasks and their grading, and where a learner stands, with the
// overview a content owner reads. Which host admits each route is
// `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import { activeModel } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import {
  baseUrl,
  connectionString,
  createTestApi,
  learnerSessionOn,
  type Signed,
} from "./testing.ts";

const { database, api, signUp } = createTestApi();

const stored = (learnerId: string) => testing.readStoredEvidence(database, learnerId);

const organizationId = "learning-test-org";
const otherOrganizationId = "learning-test-other-org";
/** Registered as `organizationId`'s own domain, which serves its learn app. */
const organizationOrigin = "https://learning-test.example.com";
/** Registered as `otherOrganizationId`'s. */
const otherOrganizationOrigin = "https://learning-test-other.example.com";
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
/** An organization admin: reads progress, and studies like any member. */
let teacher!: Signed;
let courseId!: string;
/** The learner's organization's, and teaching nothing yet: always caught up. */
let emptyCourseId!: string;
let foreignCourseId!: string;
let pastTense!: string;
/** A choice task on the past tense, correct at index 0. */
let pastTenseTask!: string;

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

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the learning routes", () => {
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
    await testing.clearLearnerHistory(database, [learner.id, classmate.id, teacher.id]);
  });

  test("refuses a request carrying no session", async () => {
    expect((await next(courseId)).status).toBe(401);
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

  test("answers a course on its own organization's domain and the installation's, and 404 elsewhere", async () => {
    // A member of both, so only the host can be what refuses.
    const both = await signUp();
    await database.insert(member).values(
      [organizationId, otherOrganizationId].map((id) => ({
        id: `${id}:${both.id}`,
        organizationId: id,
        userId: both.id,
        role: "member",
        createdAt: at,
      })),
    );
    const on = async (origin: string) =>
      api.request(`${origin}/api/courses/${courseId}/next`, {
        headers: { cookie: await learnerSessionOn(api, origin, both.cookie) },
      });

    try {
      expect((await on(organizationOrigin)).status).toBe(200);
      expect((await next(courseId, both.cookie)).status).toBe(200);
      expect((await on(otherOrganizationOrigin)).status).toBe(404);
    } finally {
      // Out of the roster the other tests read, even when one fails.
      await database.delete(member).where(eq(member.userId, both.id));
    }
  });

  test("answers a learner on a learn domain by its learner session alone", async () => {
    const session = await learnerSessionOn(api, organizationOrigin, learner.cookie);
    const on = (origin: string, cookie: string) =>
      api.request(`${origin}/api/courses/${courseId}/next`, { headers: { cookie } });

    expect((await on(organizationOrigin, session)).status).toBe(200);
    // The account's own cookie, which a learn domain may still hold from
    // before learner sessions; and a learner session where its organization
    // is not served, which a browser would not even send.
    expect((await on(organizationOrigin, learner.cookie)).status).toBe(401);
    expect((await on(otherOrganizationOrigin, session)).status).toBe(401);
    expect((await on("https://learning-test-unknown.example.com", session)).status).toBe(401);
    expect((await on(baseUrl, session)).status).toBe(401);
  });

  test("answers a course's overview on the installation's host only", async () => {
    // It lists the organization's members, a console's page, not a learner's.
    const session = await learnerSessionOn(api, organizationOrigin, teacher.cookie);
    const on = (origin: string, cookie: string) =>
      api.request(`${origin}/api/courses/${courseId}/progress`, { headers: { cookie } });

    expect((await on(baseUrl, teacher.cookie)).status).toBe(200);
    expect((await on(organizationOrigin, session)).status).toBe(401);
    expect((await on(organizationOrigin, teacher.cookie)).status).toBe(401);
  });

  test("lets a learner session read its own progress, and no one else's", async () => {
    // An administrator's, handed over like anyone's: a learner there.
    const cookie = await learnerSessionOn(api, organizationOrigin, teacher.cookie);
    const read = (learnerId: string) =>
      api.request(`${organizationOrigin}/api/courses/${courseId}/learners/${learnerId}/progress`, {
        headers: { cookie },
      });

    expect((await read(teacher.id)).status).toBe(200);
    expect((await read(learner.id)).status).toBe(404);
    expect((await progress(courseId, learner.id, teacher.cookie)).status).toBe(200);
  });

  test("reaches nothing once its member leaves, though the session lasts", async () => {
    const leaving = await signUp();
    await database.insert(member).values({
      id: `${organizationId}:${leaving.id}`,
      organizationId,
      userId: leaving.id,
      role: "member",
      createdAt: at,
    });
    const cookie = await learnerSessionOn(api, organizationOrigin, leaving.cookie);
    const nextOnDomain = () =>
      api.request(`${organizationOrigin}/api/courses/${courseId}/next`, { headers: { cookie } });
    expect((await nextOnDomain()).status).toBe(200);

    await database.delete(member).where(eq(member.userId, leaving.id));

    expect((await nextOnDomain()).status).toBe(404);
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
      objectives: [{ objectiveId: pastTense, title: "Past tense", phase: "unseen", evidence: [] }],
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
          evidence: [{ outcome: "failure", at: recordedAt.toISOString() }],
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
          // A stability of one day: recall reaches target a day after, and is
          // due from the next millisecond.
          dueAt: new Date(later.getTime() + 86_400_001).toISOString(),
          // Oldest first: what the standing was replayed from, in that order.
          evidence: [
            { outcome: "failure", at: recordedAt.toISOString() },
            { outcome: "success", at: later.toISOString() },
          ],
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

  test("shows a content owner each learner's standings in a course, and each objective's, in the documented shape", async () => {
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "overview-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);

    const response = await courseProgress(courseId, teacher.cookie);
    expect(response.status).toBe(200);
    // Exact counts are the use case's to prove; other tests add members.
    const anyCounts = {
      unseen: expect.any(Number),
      acquiring: expect.any(Number),
      retained: expect.any(Number),
      due: expect.any(Number),
    };
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
      objectives: expect.arrayContaining([
        { objectiveId: pastTense, title: expect.any(String), standings: anyCounts },
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
    const secondOrganizationId = "learning-test-second-org";
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

    // On an organization's domain, that organization's alone.
    const onDomain = await api.request(`${organizationOrigin}/api/courses`, {
      headers: { cookie: await learnerSessionOn(api, organizationOrigin, learner.cookie) },
    });
    const domainIds = ((await onDomain.json()) as { courses: { id: string }[] }).courses.map(
      ({ id }) => id,
    );
    expect(domainIds).toContain(courseId);
    expect(domainIds).not.toContain(secondCourseId);

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
      // What PostgreSQL cannot store as sent (`storableJson`): a NUL, or an
      // unpaired surrogate, which would make `a\ud800` the same ID as `a\udfff`.
      await postAttempt(courseId, { ...attempt, id: "a\u0000" }, learner.cookie),
      await postAttempt(courseId, { ...attempt, id: "a\ud800" }, learner.cookie),
      await postAttempt(courseId, { ...attempt, taskId: "\u0000" }, learner.cookie),
      await postAttempt(
        courseId,
        { ...attempt, response: { "\u0000": 1, choice: 0 } },
        learner.cookie,
      ),
      await postAttempt("c%00", attempt, learner.cookie),
    ];

    expect(refusals.map((response) => response.status)).toEqual([
      401, 403, 400, 400, 400, 404, 400, 400, 400, 400, 404,
    ]);
    expect(await stored(learner.id)).toEqual([]);
  });

  test("refuses a body that is not UTF-8, recording nothing", async () => {
    // Decoded leniently, `a<FF>` and `a<FE>` would both be `a\uFFFD`: one attempt.
    const [before, after] = JSON.stringify({
      id: "a?",
      taskId: pastTenseTask,
      response: { choice: 0 },
    }).split("?");
    const response = await api.request(`/api/courses/${courseId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: learner.cookie },
      body: new Blob([before!, new Uint8Array([0xff]), after!]),
    });

    expect(response.status).toBe(400);
    expect(await stored(learner.id)).toEqual([]);
  });

  test("answers a path carrying a NUL as naming nothing", async () => {
    const responses = [
      await activity("c%00", learner.cookie),
      await progress(courseId, "l%00", teacher.cookie),
      // Decoded by Hono to a NUL after the malformed escape.
      await activity("%ZZ%00", learner.cookie),
    ];

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  test("grades an attempt sent on a learn domain by its learner session", async () => {
    // As the learn app sends it: its own origin, its learner session; an
    // administrator's, since membership in any role is enrollment.
    const cookie = await learnerSessionOn(api, organizationOrigin, teacher.cookie);
    const attempt = { id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 0 } };

    const graded = await api.request(`${organizationOrigin}/api/courses/${courseId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: organizationOrigin, cookie },
      body: JSON.stringify(attempt),
    });

    expect(graded.status).toBe(200);
    expect(await graded.json()).toEqual({
      outcome: "success",
      correctChoice: 0,
      explanation: "Preterite.",
    });
    expect(await stored(teacher.id)).toHaveLength(1);
  });
});
