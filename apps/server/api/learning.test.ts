// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The learning routes (`learning.ts`): a learner's courses, what to do next in
// one, its tasks and their grading, and where a learner stands, with the
// overview a content owner reads. Which host admits each route is
// `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { course, member, taskReport } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { NEW_OBJECTIVES_PER_DAY } from "../application/daily-limit.ts";
import { registerLearnDomain } from "../application/index.ts";
import { activeModel, REPEATED_MISSES_THRESHOLD } from "../learning/index.ts";
import {
  createCitations,
  createCourse,
  createObjectives,
  createSource,
  recordEvidence,
} from "../persistence/index.ts";
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
/** A moment as JSON carries it: `asOf` is read off the real clock. */
const ISO_MOMENT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
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
/** The learner's organization's, and teaching nothing yet: always empty. */
let emptyCourseId!: string;
let foreignCourseId!: string;
let pastTense!: string;
/** A choice task on the past tense, correct at index 0. */
let pastTenseTask!: string;

/** Retains the past tense for `learnerId` a moment ago: caught up on the Spanish course. */
function retainPastTense(learnerId: string) {
  const moment = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  return recordEvidence(database, { learnerId, organizationId }, [
    { id: "retained", objectiveId: pastTense, outcome: "success", at: moment },
  ]);
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
    // Under the learner's first epoch unless the test names another, or none.
    body: JSON.stringify(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { historyEpoch: 0, ...body }
        : body,
    ),
  });
}

function postReport(
  courseId: string,
  attemptId: string,
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return api.request(`/api/courses/${courseId}/attempts/${attemptId}/report`, {
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
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Spanish",
        objectiveIds: [pastTense],
      })
    ).id;
    emptyCourseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Not started",
        objectiveIds: [],
      })
    ).id;

    const theirs = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourseId = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Somebody else's",
        objectiveIds: [theirs[0]!],
      })
    ).id;

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
    const empty = await next(emptyCourseId, learner.cookie);
    await retainPastTense(learner.id);
    const caughtUp = await next(courseId, learner.cookie);
    const unavailable = await next(foreignCourseId, learner.cookie);
    const refused = await next(courseId);

    // Asserted, so that identical failures could not pass as coverage of
    // different answers.
    const responses = [answered, empty, caughtUp, unavailable, refused];
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 204, 404, 401]);
    for (const response of responses) {
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
    await retainPastTense(learner.id);
    await retainPastTense(classmate.id);

    expect((await next(courseId, learner.cookie)).status).toBe(204);
    expect((await next(courseId, classmate.cookie)).status).toBe(204);
    expect((await next(courseId, outsider.cookie)).status).toBe(404);
  });

  test("says a course with no objectives is empty, never caught up, to its members alone", async () => {
    // Caught up would tell a learner on their first day that they had finished.
    const outsider = await signUp();
    for (const read of [next, activity]) {
      for (const member of [learner, classmate]) {
        const empty = await read(emptyCourseId, member.cookie);
        expect(empty.status).toBe(200);
        expect(await empty.json()).toEqual({ empty: true });
      }
      expect((await read(emptyCourseId, outsider.cookie)).status).toBe(404);
    }
  });

  test("shows a content owner where a learner stands, in the documented shape", async () => {
    // Pinned field by field, as the decision is: the body serializes
    // `LearnerProgressReport`, and a rename inside `learning` would reshape it.
    const unseen = await progress(courseId, learner.id, teacher.cookie);
    expect(unseen.status).toBe(200);
    expect(await unseen.json()).toEqual({
      modelVersion: activeModel.version,
      asOf: expect.stringMatching(ISO_MOMENT),
      historyEpoch: 0,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      // Results recorded through the API, none an attempt answered here.
      lastPractisedAt: null,
      objectives: [{ objectiveId: pastTense, title: "Past tense", phase: "unseen", evidence: [] }],
    });

    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "progress-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);
    expect(await (await progress(courseId, learner.id, teacher.cookie)).json()).toEqual({
      modelVersion: activeModel.version,
      asOf: expect.stringMatching(ISO_MOMENT),
      historyEpoch: 0,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      lastPractisedAt: null,
      objectives: [
        {
          objectiveId: pastTense,
          title: "Past tense",
          phase: "acquiring",
          lastEvidenceAt: recordedAt.toISOString(),
          misses: { count: 1, lastMissAt: recordedAt.toISOString(), everSucceeded: false },
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
      asOf: expect.stringMatching(ISO_MOMENT),
      historyEpoch: 0,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      lastPractisedAt: null,
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

  test("leaves the evidence out when asked, and refuses a value it does not know", async () => {
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "summary-failed", objectiveId: pastTense, outcome: "failure", at: recordedAt },
    ]);
    const path = `/api/courses/${courseId}/learners/${learner.id}/progress`;
    const read = (query: string) =>
      api.request(`${path}${query}`, { headers: { cookie: teacher.cookie } });

    const full = (await (await read("?includeHistory=true")).json()) as {
      objectives: { evidence: unknown[]; misses?: unknown }[];
    };
    expect(full.objectives[0]!.evidence).toHaveLength(1);
    // The same report, read at its own moment, but for the evidence: misses, a
    // count, stay.
    const { evidence: _evidence, ...standing } = full.objectives[0]!;
    expect(standing.misses).toMatchObject({ count: 1 });
    expect(await (await read("?includeHistory=false")).json()).toEqual({
      ...full,
      asOf: expect.stringMatching(ISO_MOMENT),
      historyEpoch: 0,
      objectives: [standing],
    });
    // Read as the default, a typo would send the whole history unnoticed.
    expect((await read("?includeHistory=no")).status).toBe(400);
    expect((await read("?includeHistory=False")).status).toBe(400);
    expect((await read("?includeHistory=true&includeHistory=false")).status).toBe(400);
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
    // Three misses: repeated misses, named on the objective.
    const second = (index: number) => new Date(recordedAt.getTime() + index * 1000);
    await recordEvidence(
      database,
      { learnerId: learner.id, organizationId },
      [0, 1, 2].map((index) => ({
        id: `overview-failed-${index}`,
        objectiveId: pastTense,
        outcome: "failure" as const,
        at: second(index),
      })),
    );

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
      open: true,
      modelVersion: activeModel.version,
      asOf: expect.stringMatching(ISO_MOMENT),
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      learners: expect.arrayContaining([
        {
          userId: learner.id,
          name: expect.any(String),
          roles: ["member"],
          standings: { unseen: 0, acquiring: 1, retained: 0, due: 0 },
          repeatedMisses: 1,
          lastPractisedAt: null,
        },
      ]),
      objectives: expect.arrayContaining([
        {
          objectiveId: pastTense,
          title: expect.any(String),
          standings: anyCounts,
          repeatedMisses: expect.arrayContaining([
            {
              userId: learner.id,
              name: expect.any(String),
              misses: { count: 3, lastMissAt: second(2).toISOString(), everSucceeded: false },
            },
          ]),
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
    const secondOrganizationId = "learning-test-second-org";
    await testing.seedOrganization(database, {
      organizationId: secondOrganizationId,
      learnerIds: [learner.id],
      at,
    });
    const { id: secondCourseId } = await createCourse(database, {
      published: true,
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

  test("lists each course with where the learner stands in it when asked, and only so", async () => {
    await retainPastTense(learner.id);
    const list = (query: string, cookie = learner.cookie) =>
      api.request(`/api/courses${query}`, { headers: { cookie } });

    const response = await list("?standing=true");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { courses } = (await response.json()) as {
      courses: { id: string; standing: Record<string, number> }[];
    };
    const standing = (id: string) => courses.find((each) => each.id === id)?.standing;
    expect(standing(courseId)).toEqual({
      retained: 1,
      dueForReview: 0,
      learning: 0,
      notStarted: 0,
    });
    expect(standing(emptyCourseId)).toEqual({
      retained: 0,
      dueForReview: 0,
      learning: 0,
      notStarted: 0,
    });
    // Their own standing: a classmate's evidence is not theirs.
    const theirs = (await (await list("?standing=true", classmate.cookie)).json()) as {
      courses: { id: string; standing: Record<string, number> }[];
    };
    expect(theirs.courses.find((each) => each.id === courseId)?.standing.notStarted).toBe(1);

    // The plain list stays plain; anything but `true`, or beside a number, is refused.
    const plain = (await (await list("")).json()) as { courses: object[] };
    expect(plain.courses.every((each) => !("standing" in each))).toBe(true);
    for (const query of ["?standing=false", "?standing=", "?standing=true&number=1"]) {
      expect((await list(query)).status, query).toBe(400);
    }
    expect((await api.request("/api/courses?standing=true")).status).toBe(401);
  });

  test("counts each course's standing as the learner's own progress report counts it, as of now", async () => {
    type Standing = { phase: string; due?: boolean };
    const counted = async () => {
      const { courses } = (await (
        await api.request("/api/courses?standing=true", { headers: { cookie: learner.cookie } })
      ).json()) as { courses: { id: string; standing: Record<string, number> }[] };
      return courses.find(({ id }) => id === courseId)!.standing;
    };
    // The report's standings, counted the same way: what the list must agree with.
    const reported = async () => {
      const { objectives } = (await (
        await progress(courseId, learner.id, learner.cookie)
      ).json()) as {
        objectives: Standing[];
      };
      const counts = { retained: 0, dueForReview: 0, learning: 0, notStarted: 0 };
      for (const { phase, due } of objectives) {
        if (phase === "unseen") counts.notStarted++;
        else if (phase === "acquiring") counts.learning++;
        else if (due) counts.dueForReview++;
        else counts.retained++;
      }
      return counts;
    };
    const now = Math.floor(Date.now() / 1000) * 1000;

    // Learning: a miss a moment ago.
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      {
        id: "standing-miss",
        objectiveId: pastTense,
        outcome: "failure",
        at: new Date(now - 60_000),
      },
    ]);
    expect(await counted()).toEqual({ retained: 0, dueForReview: 0, learning: 1, notStarted: 0 });
    expect(await counted()).toEqual(await reported());

    // A success dated a minute ahead is not yet evidence: still learning.
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      {
        id: "standing-ahead",
        objectiveId: pastTense,
        outcome: "success",
        at: new Date(now + 60_000),
      },
    ]);
    expect((await counted()).learning).toBe(1);

    // Due: retained long ago, its review now past.
    await testing.clearLearnerHistory(database, [learner.id]);
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      {
        id: "standing-old",
        objectiveId: pastTense,
        outcome: "success",
        at: new Date(now - 90 * 86_400_000),
      },
    ]);
    expect(await counted()).toEqual({ retained: 0, dueForReview: 1, learning: 0, notStarted: 0 });
    expect(await counted()).toEqual(await reported());

    // Two courses sharing the objective count it alike: evidence is the organization's (ADR 0009).
    const { id: sharingCourseId } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Spanish revision",
      objectiveIds: [pastTense],
    });
    // A course of a second organization the learner is also in: listed on the
    // installation's host, so only the domain's ceiling can keep it off that domain.
    const secondOrganizationId = "learning-test-standing-org";
    await testing.seedOrganization(database, {
      organizationId: secondOrganizationId,
      learnerIds: [learner.id],
      at,
    });
    const [theirObjective] = await createObjectives(database, secondOrganizationId, ["Numbers"]);
    const { id: secondCourseId } = await createCourse(database, {
      published: true,
      organizationId: secondOrganizationId,
      title: "Portuguese numbers",
      objectiveIds: [theirObjective!],
    });
    const listed = async (origin: string, cookie: string) =>
      (
        (await (
          await api.request(`${origin}/api/courses?standing=true`, { headers: { cookie } })
        ).json()) as { courses: { id: string; standing: object }[] }
      ).courses;

    const everywhere = await listed(baseUrl, learner.cookie);
    const ids = everywhere.map(({ id }) => id);
    expect(ids).toContain(courseId);
    expect(ids).toContain(secondCourseId);
    expect(everywhere.find(({ id }) => id === sharingCourseId)?.standing).toEqual(await counted());
    expect(everywhere.find(({ id }) => id === secondCourseId)?.standing).toEqual({
      retained: 0,
      dueForReview: 0,
      learning: 0,
      notStarted: 1,
    });

    // On an organization's domain, that organization's courses alone, with their standing.
    const onDomain = await listed(
      organizationOrigin,
      await learnerSessionOn(api, organizationOrigin, learner.cookie),
    );
    const domainIds = onDomain.map(({ id }) => id);
    expect(domainIds).toContain(courseId);
    expect(domainIds).not.toContain(secondCourseId);
    expect(domainIds).not.toContain(foreignCourseId);
    expect(onDomain.find(({ id }) => id === courseId)?.standing).toEqual(await counted());
  });

  test("finds a course by its number on its own organization's domain alone", async () => {
    // A member of both, whose organizations each number a course alike.
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
    const numberOf = async (id: string) =>
      (await database.select({ number: course.number }).from(course).where(eq(course.id, id)))[0]!
        .number;
    const [number, foreignNumber] = [await numberOf(courseId), await numberOf(foreignCourseId)];
    await database.update(course).set({ number }).where(eq(course.id, foreignCourseId));
    const find = async (origin: string, numbered: string) =>
      api.request(`${origin}/api/courses?${new URLSearchParams({ number: numbered })}`, {
        headers: {
          cookie:
            origin === baseUrl ? both.cookie : await learnerSessionOn(api, origin, both.cookie),
        },
      });
    const found = async (response: Response) =>
      ((await response.json()) as { courses: { id: string }[] }).courses.map(({ id }) => id);

    try {
      expect(await found(await find(organizationOrigin, `${number}`))).toEqual([courseId]);
      expect(await found(await find(otherOrganizationOrigin, `${number}`))).toEqual([
        foreignCourseId,
      ]);
      // Serving both, the installation's host can tell neither by number.
      expect(await found(await find(baseUrl, `${number}`))).toEqual([]);
      for (const malformed of ["", "01", "+1", "-1", "1.5", "1e3", "x", "2147483648"]) {
        expect((await find(organizationOrigin, malformed)).status).toBe(400);
      }
    } finally {
      // As the other tests read them, even when one fails.
      await database.delete(member).where(eq(member.userId, both.id));
      await database
        .update(course)
        .set({ number: foreignNumber })
        .where(eq(course.id, foreignCourseId));
    }
  });

  test("serves the learner a task in the documented shape, never its answer", async () => {
    const response = await activity(courseId, learner.cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      decision: { objectiveId: pastTense, modelVersion: activeModel.version, intent: "introduce" },
      objective: { id: pastTense, title: "Past tense" },
      historyEpoch: 0,
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
    expect((await activity(emptyCourseId, learner.cookie)).status).toBe(200);
    await retainPastTense(learner.id);
    expect((await activity(courseId, learner.cookie)).status).toBe(204);
  });

  test("answers the daily limit once only new objectives are left, and 400 to an unknown time zone", async () => {
    const elsewhere = await createObjectives(
      database,
      organizationId,
      Array.from({ length: NEW_OBJECTIVES_PER_DAY }, (_, i) => `Elsewhere ${i}`),
    );
    // Started now, and asked about in a zone where it is about noon, so neither
    // falls on another day there however close to midnight the suite runs.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const offset = 12 - now.getUTCHours();
    // Etc/GMT's signs are POSIX's: Etc/GMT-3 is three hours ahead of UTC.
    const noon = `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    await recordEvidence(
      database,
      { learnerId: learner.id, organizationId },
      elsewhere.map((objectiveId) => ({
        id: objectiveId,
        objectiveId,
        outcome: "success" as const,
        at: now,
      })),
    );

    for (const route of ["next", "activity"]) {
      const ask = (timeZone: string) =>
        api.request(`/api/courses/${courseId}/${route}?${new URLSearchParams({ timeZone })}`, {
          headers: { cookie: learner.cookie },
        });
      const response = await ask(noon);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ dailyLimit: NEW_OBJECTIVES_PER_DAY });
      expect((await ask("Mars/Olympus_Mons")).status).toBe(400);
    }
  });

  test("answers the decision without a task when its objective has none", async () => {
    const [untaught] = await createObjectives(database, organizationId, ["Untaught"]);
    const { id: untaughtCourseId } = await createCourse(database, {
      published: true,
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
      kind: "choice",
      outcome: "failure",
      correctChoice: 0,
      explanation: "Preterite.",
      reviewable: false,
    });

    // Its only task rests, since the learner was just shown the answer.
    // Whole seconds; the exact boundary is the application tests'.
    const { objective, retryAfter, reviewable } = (await (
      await activity(courseId, learner.cookie)
    ).json()) as { objective: unknown; retryAfter: number; reviewable: boolean };
    expect(objective).toEqual({ id: pastTense, title: "Past tense" });
    expect(reviewable).toBe(false);
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

  test("grades a typed answer, and answers a resend of it alike", async () => {
    const [word] = (await createObjectives(database, organizationId, ["To be"])) as [string];
    const { id: wordCourse } = await createCourse(database, {
      published: true,
      organizationId,
      title: "German",
      objectiveIds: [word],
    });
    const typedTask = await testing.createTask(database, {
      organizationId,
      objectiveId: word,
      body: { kind: "typed", prompt: "I am tired: Ich ___ müde.", accepted: ["bin"] },
      createdAt: at,
    });
    const attempt = { id: crypto.randomUUID(), taskId: typedTask, response: { text: " Bin " } };

    const answered = await postAttempt(wordCourse, attempt, learner.cookie);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      kind: "typed",
      outcome: "success",
      correctAnswer: "bin",
      reviewable: false,
    });

    const resent = await postAttempt(wordCourse, attempt, learner.cookie);
    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({
      kind: "typed",
      outcome: "success",
      correctAnswer: "bin",
      reviewable: false,
    });
    expect(await stored(learner.id)).toHaveLength(1);

    // Graded alike, but not the text sent under this ID.
    const changed = { ...attempt, response: { text: "bin" } };
    expect((await postAttempt(wordCourse, changed, learner.cookie)).status).toBe(409);
  });

  test("refuses attempts it cannot or must not record, recording none", async () => {
    const attempt = {
      id: crypto.randomUUID(),
      taskId: pastTenseTask,
      response: { choice: 0 },
      historyEpoch: 0,
    };

    const refusals = [
      await postAttempt(courseId, attempt),
      await postAttempt(courseId, attempt, learner.cookie, { origin: "https://evil.example.com" }),
      await postAttempt(courseId, { ...attempt, id: "" }, learner.cookie),
      await postAttempt(courseId, { ...attempt, id: "x".repeat(129) }, learner.cookie),
      await postAttempt(courseId, { ...attempt, response: { choice: 5 } }, learner.cookie),
      // Never read as whichever field is looked at first (ADR 0038).
      await postAttempt(
        courseId,
        { ...attempt, response: { choice: 0, reveal: true } },
        learner.cookie,
      ),
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
      // A boolean or nothing (ADR 0054).
      await postAttempt(courseId, { ...attempt, reviewedTeaching: "true" }, learner.cookie),
      await postAttempt(courseId, { ...attempt, reviewedTeaching: null }, learner.cookie),
    ];

    expect(refusals.map((response) => response.status)).toEqual([
      401, 403, 400, 400, 400, 400, 404, 400, 400, 400, 400, 404, 400, 400,
    ]);
    expect(await stored(learner.id)).toEqual([]);
  });

  test("reviews an objective the learner answered on, and nothing before (learner-loop-24)", async () => {
    const [rule] = (await createObjectives(database, organizationId, ["Preterite"])) as [string];
    const [uncited] = (await createObjectives(database, organizationId, ["Uncited"])) as [string];
    const unit = await createSource(database, {
      organizationId,
      title: "Unidad 4",
      text: "Hablé con mi madre.",
      url: "https://example.com/unidad-4",
      createdAt: at,
    });
    await createCitations(
      database,
      organizationId,
      [{ objectiveId: rule, sourceId: unit, start: 0, end: 19 }],
      at,
    );
    const { id: ruleCourse } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Grammar",
      objectiveIds: [rule, uncited],
    });
    const ruleTask = await testing.createTask(database, {
      organizationId,
      objectiveId: rule,
      body: { kind: "choice", prompt: "Hablé?", options: ["past", "present"], answer: 0 },
      createdAt: at,
    });
    const review = (objectiveId: string, cookie?: string) =>
      api.request(
        `/api/courses/${ruleCourse}/objectives/${objectiveId}/review`,
        cookie ? { headers: { cookie } } : undefined,
      );

    expect((await review(rule)).status).toBe(401);
    // Never a preview of the answers.
    expect((await review(rule, learner.cookie)).status).toBe(404);

    const missed = await postAttempt(
      ruleCourse,
      { id: crypto.randomUUID(), taskId: ruleTask, response: { choice: 1 } },
      learner.cookie,
    );
    expect(await missed.json()).toMatchObject({ outcome: "failure", reviewable: true });

    const shown = await review(rule, learner.cookie);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("private, no-store");
    expect(await shown.json()).toEqual({
      title: "Preterite",
      passages: [
        {
          quote: "Hablé con mi madre.",
          source: { title: "Unidad 4", url: "https://example.com/unidad-4" },
        },
      ],
    });
    // Reading it records nothing.
    expect(await stored(learner.id)).toHaveLength(1);
    // Answered on, the course's other objective has nothing to show.
    await recordEvidence(database, { learnerId: learner.id, organizationId }, [
      { id: "uncited", objectiveId: uncited, outcome: "failure", at: recordedAt },
    ]);
    expect((await review(uncited, learner.cookie)).status).toBe(204);
    // Another learner, who never answered on it, and an objective outside the course.
    expect((await review(rule, classmate.cookie)).status).toBe(404);
    expect(
      (
        await api.request(`/api/courses/${courseId}/objectives/${rule}/review`, {
          headers: { cookie: learner.cookie },
        })
      ).status,
    ).toBe(404);
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

  test("refuses an attempt without a history epoch it can read, recording nothing", async () => {
    for (const epoch of [undefined, null, "0", -1, 0.5]) {
      const refused = await postAttempt(
        courseId,
        {
          id: crypto.randomUUID(),
          taskId: pastTenseTask,
          response: { choice: 0 },
          historyEpoch: epoch,
        },
        learner.cookie,
      );
      expect([epoch, refused.status]).toEqual([epoch, 400]);
    }
    expect(await stored(learner.id)).toEqual([]);
  });

  test("answers an attempt under another epoch a coded 409, apart from the bare ones", async () => {
    const refused = await postAttempt(
      courseId,
      { id: crypto.randomUUID(), taskId: pastTenseTask, response: { choice: 0 }, historyEpoch: 1 },
      learner.cookie,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "HISTORY_ERASED" });
    expect(await stored(learner.id)).toEqual([]);
  });

  test("grades an attempt sent on a learn domain by its learner session", async () => {
    // As the learn app sends it: its own origin, its learner session; an
    // administrator's, since membership in any role is enrollment.
    const cookie = await learnerSessionOn(api, organizationOrigin, teacher.cookie);
    const attempt = {
      id: crypto.randomUUID(),
      taskId: pastTenseTask,
      response: { choice: 0 },
      historyEpoch: 0,
    };

    const graded = await api.request(`${organizationOrigin}/api/courses/${courseId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: organizationOrigin, cookie },
      body: JSON.stringify(attempt),
    });

    expect(graded.status).toBe(200);
    expect(await graded.json()).toEqual({
      kind: "choice",
      outcome: "success",
      correctChoice: 0,
      explanation: "Preterite.",
      reviewable: false,
    });
    expect(await stored(teacher.id)).toHaveLength(1);
  });

  test("stores a learner's report of their attempt, answers it alike, and refuses another (learner-loop-22)", async () => {
    const attemptId = crypto.randomUUID();
    const answered = await postAttempt(
      courseId,
      { id: attemptId, taskId: pastTenseTask, response: { choice: 1 } },
      learner.cookie,
    );
    expect(answered.status).toBe(200);
    const evidence = await stored(learner.id);

    const sent = { reason: "answer-correct", note: "  Both fit.  " };
    const first = await postReport(courseId, attemptId, sent, learner.cookie);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const report = await first.json();
    expect(report).toEqual({
      reason: "answer-correct",
      note: "Both fit.",
      at: expect.stringMatching(ISO_MOMENT),
    });

    const again = await postReport(courseId, attemptId, sent, learner.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(report);

    const changed = await postReport(courseId, attemptId, { reason: "confusing" }, learner.cookie);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: expect.any(String), code: "ALREADY_REPORTED" });
    // Grading and evidence untouched.
    expect(await stored(learner.id)).toEqual(evidence);
  });

  test("refuses reports it must not store, storing none", async () => {
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    const success = crypto.randomUUID();
    await postAttempt(
      courseId,
      { id: mine, taskId: pastTenseTask, response: { choice: 1 } },
      learner.cookie,
    );
    await postAttempt(
      courseId,
      { id: theirs, taskId: pastTenseTask, response: { choice: 1 } },
      classmate.cookie,
    );
    await postAttempt(
      courseId,
      { id: success, taskId: pastTenseTask, response: { choice: 0 } },
      teacher.cookie,
    );
    const keyWrong = { reason: "key-wrong" };

    const refusals = [
      await postReport(courseId, mine, keyWrong),
      await postReport(courseId, mine, keyWrong, learner.cookie, {
        origin: "https://evil.example.com",
      }),
      await postReport(courseId, mine, { reason: "nonsense" }, learner.cookie),
      await postReport(courseId, mine, { reason: "other" }, learner.cookie),
      await postReport(
        courseId,
        mine,
        { reason: "confusing", note: "x".repeat(501) },
        learner.cookie,
      ),
      await postReport(courseId, mine, { reason: "confusing", note: "a\u0000" }, learner.cookie),
      await postReport(courseId, success, { reason: "answer-correct" }, teacher.cookie),
      await postReport(courseId, theirs, keyWrong, learner.cookie),
      await postReport(foreignCourseId, mine, keyWrong, learner.cookie),
      await postReport(courseId, "nobody", keyWrong, learner.cookie),
    ];

    expect(refusals.map((response) => response.status)).toEqual([
      401, 403, 400, 400, 400, 400, 400, 404, 404, 404,
    ]);
    for (const response of refusals) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const reports = await database
      .select()
      .from(taskReport)
      .where(inArray(taskReport.learnerId, [learner.id, classmate.id, teacher.id]));
    expect(reports).toEqual([]);
  });

  test("stores a report sent on a learn domain by its learner session", async () => {
    const cookie = await learnerSessionOn(api, organizationOrigin, learner.cookie);
    const attemptId = crypto.randomUUID();
    await postAttempt(
      courseId,
      { id: attemptId, taskId: pastTenseTask, response: { reveal: true } },
      learner.cookie,
    );

    const reported = await api.request(
      `${organizationOrigin}/api/courses/${courseId}/attempts/${attemptId}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: organizationOrigin, cookie },
        body: JSON.stringify({ reason: "confusing" }),
      },
    );

    expect(reported.status).toBe(201);
  });

  describe("a tool reading learners' data (access-45)", () => {
    /** A second organization the teacher administers, its setting apart from the first's. */
    const secondOrganizationId = "learning-test-tools-org";
    let secondCourseId!: string;

    const bearer = (signed: Signed) => ({ authorization: `Bearer ${signed.token}` });
    const read = (path: string, headers: Record<string, string>) => api.request(path, { headers });
    const overviewOf = (course: string, headers: Record<string, string>) =>
      read(`/api/courses/${course}/progress`, headers);
    const reportOf = (learnerId: string, headers: Record<string, string>, course = courseId) =>
      read(`/api/courses/${course}/learners/${learnerId}/progress`, headers);

    beforeAll(async () => {
      await testing.seedOrganization(database, {
        organizationId: secondOrganizationId,
        learnerIds: [learner.id],
        adminIds: [teacher.id],
        at,
      });
      const [objectiveId] = await createObjectives(database, secondOrganizationId, ["Second"]);
      secondCourseId = (
        await createCourse(database, {
          published: true,
          organizationId: secondOrganizationId,
          title: "Second",
          objectiveIds: [objectiveId!],
        })
      ).id;
    });

    beforeEach(async () => {
      await testing.setToolsReadLearnerData(database, organizationId, false);
      await testing.setToolsReadLearnerData(database, secondOrganizationId, false);
    });

    test("refuses a token the overview and another's report while off, as a missing course", async () => {
      expect((await overviewOf(courseId, bearer(teacher))).status).toBe(404);
      expect((await reportOf(learner.id, bearer(teacher))).status).toBe(404);
      expect((await overviewOf("no-such-course", bearer(teacher))).status).toBe(404);
    });

    test("answers a token the same requests once on", async () => {
      await testing.setToolsReadLearnerData(database, organizationId, true);

      expect((await overviewOf(courseId, bearer(teacher))).status).toBe(200);
      expect((await reportOf(learner.id, bearer(teacher))).status).toBe(200);
    });

    test("lets the console read either way", async () => {
      for (const allowed of [false, true]) {
        await testing.setToolsReadLearnerData(database, organizationId, allowed);
        expect((await overviewOf(courseId, { cookie: teacher.cookie })).status).toBe(200);
        expect((await reportOf(learner.id, { cookie: teacher.cookie })).status).toBe(200);
      }
    });

    test("lets a learner's token read their own report while off", async () => {
      expect((await reportOf(learner.id, bearer(learner))).status).toBe(200);
    });

    test("refuses a browser's cookie carrying a token's Authorization, as a tool", async () => {
      const both = { cookie: teacher.cookie, ...bearer(teacher) };

      expect((await overviewOf(courseId, both)).status).toBe(404);
      expect((await reportOf(learner.id, both)).status).toBe(404);
    });

    test("acts as the token's person, not the cookie's, when a request carries both", async () => {
      await testing.setToolsReadLearnerData(database, organizationId, true);

      // The token's person decides, whichever cookie rides along.
      expect(
        (await overviewOf(courseId, { cookie: teacher.cookie, ...bearer(learner) })).status,
      ).toBe(404);
      expect(
        (await overviewOf(courseId, { cookie: learner.cookie, ...bearer(teacher) })).status,
      ).toBe(200);
    });

    test("answers one admin's token by each organization's own setting", async () => {
      await testing.setToolsReadLearnerData(database, secondOrganizationId, true);

      expect((await overviewOf(secondCourseId, bearer(teacher))).status).toBe(200);
      expect((await reportOf(learner.id, bearer(teacher), secondCourseId)).status).toBe(200);
      // The same learner, in the organization that has it off.
      expect((await overviewOf(courseId, bearer(teacher))).status).toBe(404);
      expect((await reportOf(learner.id, bearer(teacher))).status).toBe(404);
    });

    test("refuses a token's next request once switched off", async () => {
      await testing.setToolsReadLearnerData(database, secondOrganizationId, true);
      expect((await overviewOf(secondCourseId, bearer(teacher))).status).toBe(200);

      await testing.setToolsReadLearnerData(database, secondOrganizationId, false);

      expect((await overviewOf(secondCourseId, bearer(teacher))).status).toBe(404);
    });
  });
});
