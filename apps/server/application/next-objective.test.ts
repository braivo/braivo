// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import { chooseNextObjective } from "./next-objective.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "next-objective-test-org";
const learner = "next-objective-test-learner";
/** A real user, but not a member of the organization that owns these courses. */
const outsider = "next-objective-test-outsider";
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let pastTense!: string;
let fractions!: string;
/** Both objectives, in that order. */
let bothCourse!: string;
/** Only the past tense, for cases where a second candidate would mask the answer. */
let soloCourse!: string;
/** The learner's, and teaching nothing yet. */
let emptyCourse!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: now, ...overrides };
}

function choose(courseId: string, learnerId = learner) {
  return chooseNextObjective({
    database,
    learnerId,
    courseId,
    host: { hostname: "localhost", installation: true },
    now,
  });
}

/** The decision, having first checked that there was one to return. */
async function decide(courseId: string) {
  const next = await choose(courseId);
  if (next.kind !== "decided") throw new Error(`Expected a decision, got "${next.kind}".`);
  return next.decision;
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("choosing the next objective", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, { organizationId, learnerIds: [learner], at: now });

    const objectives = await createObjectives(database, organizationId, [
      "Past tense",
      "Fractions",
    ]);
    pastTense = objectives[0]!;
    fractions = objectives[1]!;

    bothCourse = await createCourse(database, {
      organizationId,
      title: "Both",
      objectiveIds: [pastTense, fractions],
    });
    soloCourse = await createCourse(database, {
      organizationId,
      title: "Solo",
      objectiveIds: [pastTense],
    });
    emptyCourse = await createCourse(database, {
      organizationId,
      title: "Empty",
      objectiveIds: [],
    });

    await database
      .insert(authTables.user)
      .values({
        id: outsider,
        name: outsider,
        email: `${outsider}@example.com`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner]);
  });

  test("introduces the course's first objective for a learner with no evidence", async () => {
    expect(await decide(bothCourse)).toEqual({
      objectiveId: pastTense,
      modelVersion: activeModel.version,
      intent: "introduce",
    });
  });

  test("reteaches an objective the learner has failed", async () => {
    await recordEvidence(database, learner, [evidence({ outcome: "failure", at: daysAgo(1) })]);

    expect(await decide(bothCourse)).toMatchObject({
      objectiveId: pastTense,
      intent: "reteach",
      lastEvidenceAt: daysAgo(1),
    });
  });

  test("reviews an objective whose recall has fallen below target", async () => {
    await recordEvidence(database, learner, [evidence({ at: daysAgo(10) })]);

    const decision = await decide(bothCourse);

    // One success gives stability 1, so ten days later r = 0.9 ** 10 — due, and
    // due outranks introducing the course's remaining new material.
    expect(decision).toMatchObject({ objectiveId: pastTense, intent: "review", stability: 1 });
    expect((decision as { retrievability: number }).retrievability).toBeCloseTo(0.9 ** 10, 10);
  });

  test("reports a learner caught up when nothing in the course is due", async () => {
    await recordEvidence(database, learner, [evidence({ at: now })]);

    expect(await choose(soloCourse)).toEqual({ kind: "caught-up" });
  });

  test("reports a learner caught up on a course that teaches nothing yet", async () => {
    // Caught up by the same reading: nothing needs attention. Treating an empty
    // course as unavailable instead would tell its own learner it is not there.
    expect(await choose(emptyCourse)).toEqual({ kind: "caught-up" });
  });

  test("absorbs evidence that arrives after evidence it predates", async () => {
    // Recorded second, but happened first. Folding in arrival order would leave
    // the objective acquiring and ask for re-teaching; replaying in event order
    // is what makes a late grading result free to accept.
    await recordEvidence(database, learner, [evidence({ id: "later", at: daysAgo(10) })]);
    await recordEvidence(database, learner, [
      evidence({ id: "earlier", outcome: "failure", at: daysAgo(20) }),
    ]);

    expect(await decide(soloCourse)).toMatchObject({
      objectiveId: pastTense,
      intent: "review",
      stability: 1,
    });
  });

  test("prefers re-teaching over reviewing, across the whole path", async () => {
    await recordEvidence(database, learner, [
      evidence({ id: "due", objectiveId: pastTense, at: daysAgo(10) }),
      evidence({ id: "failed", objectiveId: fractions, outcome: "failure", at: daysAgo(1) }),
    ]);

    expect(await decide(bothCourse)).toMatchObject({
      objectiveId: fractions,
      intent: "reteach",
    });
  });

  test("ignores evidence about objectives the course does not teach", async () => {
    // The record is read and replayed — every one of the learner's is — and an
    // estimate is built for it. Selection is what leaves it out, because the
    // course does not list it as a candidate. Material this course does not
    // teach is not this course's to re-teach, failed or not, and a failure
    // outranks everything if it ever reaches the decision.
    await recordEvidence(database, learner, [
      evidence({ id: "elsewhere", objectiveId: fractions, outcome: "failure", at: daysAgo(1) }),
    ]);

    expect(await decide(soloCourse)).toMatchObject({
      objectiveId: pastTense,
      intent: "introduce",
    });
  });

  test("carries what a learner knows from one course into another", async () => {
    // Courses order objectives, they do not own them: the past tense met in one
    // course is the same knowledge in the other, and one estimate. Anything that
    // tied evidence to the course it was produced under, rather than to the
    // objective it is about, would quietly break this and nothing else.
    // See docs/adr/0008-courses-order-objectives.md.
    await recordEvidence(database, learner, [evidence({ at: daysAgo(10) })]);

    expect(await decide(soloCourse)).toMatchObject({ objectiveId: pastTense, intent: "review" });
    expect(await decide(bothCourse)).toMatchObject({ objectiveId: pastTense, intent: "review" });
  });

  test("refuses a learner outside the course's organization", async () => {
    // Controlled within the test: the very same course still has material for a
    // member, so this is a refusal rather than an empty course.
    expect(await decide(bothCourse)).toMatchObject({ intent: "introduce" });
    expect(await choose(bothCourse, outsider)).toEqual({ kind: "unavailable" });
  });

  test("answers a missing course exactly as it answers one the learner may not see", async () => {
    // The disclosure this pair rules out: an answer that differed for a course
    // belonging to somebody else would confirm, one guess at a time, that it
    // exists.
    expect(await choose("no-such-course", outsider)).toEqual(await choose(bothCourse, outsider));
  });

  test("tells a caught-up learner apart from one who may not see the course", async () => {
    // The distinction the result exists to carry, on one course: its member is
    // told there is nothing to do, and an outsider is told nothing at all.
    // Only a member can reach the first answer, which is why giving it away
    // costs nothing.
    await recordEvidence(database, learner, [evidence({ at: now })]);

    expect(await choose(soloCourse)).toEqual({ kind: "caught-up" });
    expect(await choose(soloCourse, outsider)).toEqual({ kind: "unavailable" });
  });

  test("ignores evidence dated after the moment being decided for", async () => {
    // A grader writing between the clock being read and the evidence being read
    // would otherwise hand the model evidence from its future, which it rejects
    // — turning a recommendation into a 500 with nothing actually wrong.
    await recordEvidence(database, learner, [
      evidence({ id: "from-the-future", outcome: "failure", at: new Date(now.getTime() + 1000) }),
    ]);

    expect(await decide(soloCourse)).toMatchObject({
      objectiveId: pastTense,
      intent: "introduce",
    });
  });

  test("reports a course that does not exist as unavailable", async () => {
    // Not as caught up: a member asking about a stale course ID would otherwise
    // be told, indefinitely, that there is nothing for them to do.
    expect(await choose("no-such-course")).toEqual({ kind: "unavailable" });
  });
});
