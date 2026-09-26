// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Evidence } from "../learning/index.ts";
import {
  ConflictingEvidence,
  createCourse,
  createObjectives,
  readLearnerEvidence,
} from "../persistence/index.ts";
import { chooseNextObjective } from "./next-objective.ts";
import { NotPermitted } from "./permission.ts";
import { InvalidEvidence, recordGradedEvidence } from "./record-evidence.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "record-evidence-test-org";
const otherOrganizationId = "record-evidence-test-other-org";
const learner = "record-evidence-test-learner";
/** An admin of the organization, and so someone who may say what a learner did. */
const grader = "record-evidence-test-grader";
/** A real user, but a member of no organization. */
const outsider = "record-evidence-test-outsider";
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let pastTense!: string;
let theirObjective!: string;
let course!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: daysAgo(1), ...overrides };
}

function record(
  evidenceBatch: readonly Evidence[],
  learnerId = learner,
  gradedBy = grader,
  receivedAt = now,
) {
  return recordGradedEvidence({
    database,
    organizationId,
    gradedBy,
    learnerId,
    evidence: evidenceBatch,
    now: receivedAt,
  });
}

/**
 * Everything stored, not what a decision would see: read as of the year 9999,
 * the latest date PostgreSQL parses from `toISOString`, rather than as of `now`,
 * so a stored future-dated record could not hide from these assertions.
 */
function stored(learnerId = learner) {
  return readLearnerEvidence(database, learnerId, new Date("9999-12-31T23:59:59.999Z"));
}

const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("recording graded evidence", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [grader],
      at: now,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at: now,
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

    pastTense = (await createObjectives(database, organizationId, ["Past tense"]))[0]!;
    theirObjective = (await createObjectives(database, otherOrganizationId, ["Theirs"]))[0]!;
    course = await createCourse(database, {
      organizationId,
      title: "Spanish",
      objectiveIds: [pastTense],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner, grader, outsider]);
  });

  test("records evidence a learner's own organization graded", async () => {
    await record([evidence()]);

    expect(await stored(learner)).toEqual([
      { id: "e1", objectiveId: pastTense, outcome: "success", at: daysAgo(1) },
    ]);
  });

  test("refuses a learner who does not administer grading themselves", async () => {
    // The learner passes the other two checks for their own material — the
    // objective is their organization's and so are they. Only the role stops
    // them awarding themselves successes in the table estimates are built from.
    await expect(record([evidence()], learner, learner)).rejects.toBeInstanceOf(NotPermitted);

    expect(await stored(learner)).toEqual([]);
  });

  test("refuses evidence whose date is not a date", async () => {
    // It compares false against the allowance, so only an explicit check stops
    // it reaching the database as a driver error rather than a refusal.
    await expect(record([evidence({ at: new Date(Number.NaN) })])).rejects.toBeInstanceOf(
      InvalidEvidence,
    );
  });

  test("asks who is grading before whether the learner belongs", async () => {
    // The other order would let anyone learn who is a member by naming them.
    await expect(record([evidence()], outsider, learner)).rejects.toThrow(
      `"${learner}" may not act`,
    );
  });

  test("asks whether the learner belongs before whose objectives these are", async () => {
    await expect(record([evidence({ objectiveId: theirObjective })], outsider)).rejects.toThrow(
      `Learner "${outsider}"`,
    );
  });

  test("lets an administrator record their own evidence", async () => {
    // Deliberate: the rule is that the grader administers the organization, and
    // an administrator can write anything there already.
    await record([evidence({ id: "self" })], grader, grader);

    expect((await stored(grader)).map((row) => row.id)).toEqual(["self"]);
  });

  test("refuses a grader from outside the organization", async () => {
    await expect(record([evidence()], learner, outsider)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses a learner who is not in the organization", async () => {
    await expect(record([evidence()], outsider)).rejects.toBeInstanceOf(NotPermitted);
    expect(await stored(outsider)).toEqual([]);
  });

  test("refuses an objective another organization owns", async () => {
    // The hole this closes: nothing in the schema ties a learner and an
    // objective to one organization, so without this check one tenant could
    // attribute knowledge of another's objectives — in the table the whole
    // model treats as the source of truth.
    const rejected = record([evidence({ objectiveId: theirObjective })]);

    await expect(rejected).rejects.toThrow(theirObjective);
    expect(await stored(learner)).toEqual([]);
  });

  test("refuses an objective that does not exist", async () => {
    await expect(record([evidence({ objectiveId: "no-such-objective" })])).rejects.toBeInstanceOf(
      NotPermitted,
    );
  });

  test("rejects the whole batch when one objective is foreign", async () => {
    // Partial acceptance would leave the caller guessing which half landed.
    await expect(
      record([evidence({ id: "ours" }), evidence({ id: "theirs", objectiveId: theirObjective })]),
    ).rejects.toBeInstanceOf(NotPermitted);

    expect(await stored(learner)).toEqual([]);
  });

  test("does nothing for an empty batch", async () => {
    await record([]);

    expect(await stored(learner)).toEqual([]);
  });

  test("stays idempotent when a grading result is redelivered", async () => {
    await record([evidence({ id: "retried" })]);
    await record([evidence({ id: "retried" })]);

    expect(await stored(learner)).toEqual([
      { id: "retried", objectiveId: pastTense, outcome: "success", at: daysAgo(1) },
    ]);
  });

  test("refuses a result that disagrees with the one already under its ID", async () => {
    await record([evidence({ id: "reused" })]);

    await expect(record([evidence({ id: "reused", outcome: "failure" })])).rejects.toBeInstanceOf(
      ConflictingEvidence,
    );
    expect(await stored(learner)).toEqual([
      { id: "reused", objectiveId: pastTense, outcome: "success", at: daysAgo(1) },
    ]);
  });

  test("refuses an ID in the namespace attempts grade into", async () => {
    // Otherwise the attempt that later needs this ID could never be recorded.
    await expect(record([evidence({ id: "attempt:a1:x" })])).rejects.toBeInstanceOf(
      InvalidEvidence,
    );

    expect(await stored()).toEqual([]);
  });

  test("refuses evidence dated after it was received", async () => {
    // An hour ahead is the shape of a time-zone mistake: local time written out
    // as UTC by a grader east of Greenwich.
    await expect(record([evidence({ at: minutes(60) })])).rejects.toBeInstanceOf(InvalidEvidence);

    expect(await stored()).toEqual([]);
  });

  test("allows five minutes for clocks that disagree, and not a millisecond more", async () => {
    // Both edges, because the comparison is the whole rule: a `>=` in place of
    // `>` would refuse the first, and a missing allowance would refuse both.
    const edge = minutes(5);
    const past = new Date(edge.getTime() + 1);

    await record([evidence({ id: "at-the-edge", at: edge })]);
    await expect(record([evidence({ id: "past-it", at: past })])).rejects.toBeInstanceOf(
      InvalidEvidence,
    );

    expect((await stored()).map((row) => row.id)).toEqual(["at-the-edge"]);
  });

  test("rejects the whole batch when one record is dated ahead", async () => {
    await expect(
      record([evidence({ id: "fine" }), evidence({ id: "ahead", at: minutes(60) })]),
    ).rejects.toThrow('"ahead"');

    expect(await stored()).toEqual([]);
  });

  test("accepts evidence from long ago", async () => {
    // Importing a history kept somewhere else is legitimate, and an old date is
    // not by itself a sign of anything wrong.
    await record([evidence({ at: daysAgo(3650) })]);

    expect(await stored()).toHaveLength(1);
  });

  test("lets a grader correct a date it got wrong", async () => {
    // What refusing on the way in buys. Accepted, the mis-dated record would be
    // the first stored under this ID, the corrected resend would be ignored as a
    // redelivery, and the learner's actual result would never count.
    await expect(
      record([evidence({ id: "attempt", outcome: "failure", at: minutes(60 * 24 * 365) })]),
    ).rejects.toBeInstanceOf(InvalidEvidence);

    await record([evidence({ id: "attempt", outcome: "success", at: daysAgo(1) })]);

    expect(await stored()).toEqual([
      { id: "attempt", objectiveId: pastTense, outcome: "success", at: daysAgo(1) },
    ]);
  });

  test("refuses to judge dates against a clock that is not a date", async () => {
    // `Invalid Date` compares false against everything, so letting one through
    // would accept every record however far ahead it was dated.
    await expect(
      record([evidence({ at: minutes(60) })], learner, grader, new Date(Number.NaN)),
    ).rejects.toBeInstanceOf(RangeError);

    expect(await stored()).toEqual([]);
  });

  test("checks dates before asking who is grading", async () => {
    // Cheaper, and it gives away nothing: the answer depends on what the caller
    // sent and on the clock, not on the organization they named.
    await expect(record([evidence({ at: minutes(60) })], learner, outsider)).rejects.toBeInstanceOf(
      InvalidEvidence,
    );
  });

  test("changes what the learner is asked to do next", async () => {
    // The loop, end to end: without a write path every decision is `introduce`
    // forever, and none of the model's phases are reachable in production.
    const before = await chooseNextObjective({
      database,
      learnerId: learner,
      courseId: course,
      host: { hostname: "localhost", installation: true },
      now,
    });

    await record([evidence({ outcome: "failure" })]);
    const after = await chooseNextObjective({
      database,
      learnerId: learner,
      courseId: course,
      host: { hostname: "localhost", installation: true },
      now,
    });

    expect(before).toMatchObject({
      kind: "decided",
      decision: { objectiveId: pastTense, intent: "introduce" },
    });
    expect(after).toMatchObject({
      kind: "decided",
      decision: { objectiveId: pastTense, intent: "reteach" },
    });
  });
});
