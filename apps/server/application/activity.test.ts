// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import { createCourse, createObjectives, readLearnerEvidence } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "activity-test-org";
const otherOrganizationId = "activity-test-other-org";
const learner = "activity-test-learner";
/** A member of another organization only. */
const outsider = "activity-test-outsider";
const start = new Date("2026-06-01T00:00:00.000Z");
const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

/** Correct answer at index 0. */
const question = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong"],
  answer: 0,
});

let pastTense!: string;
/** In the course, but with no task: nothing to practise it with. */
let untaught!: string;
let fractions!: string;
let pastTenseTask!: string;
/** Fractions has two tasks, created in this order. */
let fractionsTasks!: [string, string];
/** Past tense, untaught, fractions, in that order. */
let courseId!: string;
let untaughtCourseId!: string;
let foreignTask!: string;

function activity(now: Date, learnerId = learner, course = courseId) {
  return chooseNextActivity({ database, learnerId, courseId: course, now });
}

async function decided(now: Date) {
  const next = await activity(now);
  if (next.kind !== "decided") throw new Error(`Expected an activity, got "${next.kind}".`);
  return next;
}

function answer(
  attemptId: string,
  taskId: string,
  choice: unknown,
  now: Date,
  options: { learnerId?: string; course?: string } = {},
) {
  return submitAttempt({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    attemptId,
    taskId,
    response: { choice },
    now,
  });
}

const stored = () => readLearnerEvidence(database, learner, later(10_000));

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the learner loop", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      at: start,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [outsider],
      at: start,
    });

    [pastTense, untaught, fractions] = (await createObjectives(database, organizationId, [
      "Past tense",
      "Untaught",
      "Fractions",
    ])) as [string, string, string];
    courseId = await createCourse(database, {
      organizationId,
      title: "Loop",
      objectiveIds: [pastTense, untaught, fractions],
    });
    untaughtCourseId = await createCourse(database, {
      organizationId,
      title: "Nothing to practise",
      objectiveIds: [untaught],
    });

    const task = (objectiveId: string, prompt: string, createdAt: Date) =>
      testing.createTask(database, {
        organizationId,
        objectiveId,
        body: question(prompt),
        createdAt,
      });
    pastTenseTask = await task(pastTense, "Past tense?", start);
    fractionsTasks = [
      await task(fractions, "First fraction?", start),
      await task(fractions, "Second fraction?", later(1)),
    ];

    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignTask = await testing.createTask(database, {
      organizationId: otherOrganizationId,
      objectiveId: theirs!,
      body: question("Theirs?"),
      createdAt: start,
    });
  });

  beforeEach(async () => {
    await testing.clearEvidence(database, [learner, outsider]);
  });

  test("objective, task, answer, grade, evidence, next objective", async () => {
    const first = await decided(start);
    expect(first.decision).toMatchObject({ objectiveId: pastTense, intent: "introduce" });
    // The learner is shown the question, never the answer.
    expect(first.task).toEqual({
      id: pastTenseTask,
      kind: "choice",
      prompt: "Past tense?",
      options: ["right", "wrong"],
    });

    expect(await answer("a1", pastTenseTask, 1, later(1))).toEqual({
      kind: "graded",
      grade: { outcome: "failure", answer: 0 },
    });
    expect((await decided(later(2))).decision).toMatchObject({
      objectiveId: pastTense,
      intent: "reteach",
    });

    await answer("a2", pastTenseTask, 0, later(3));
    // Untaught has no task, so selection moves past it rather than stopping.
    expect((await decided(later(4))).decision).toMatchObject({
      objectiveId: fractions,
      intent: "introduce",
    });

    expect(await stored()).toEqual([
      {
        id: `attempt:a1:${pastTense}`,
        objectiveId: pastTense,
        outcome: "failure",
        at: later(1),
      },
      {
        id: `attempt:a2:${pastTense}`,
        objectiveId: pastTense,
        outcome: "success",
        at: later(3),
      },
    ]);
  });

  test("is caught up in a course with nothing to practise", async () => {
    expect(await activity(start, learner, untaughtCourseId)).toEqual({ kind: "caught-up" });
  });

  test("rotates through an objective's tasks, least recently attempted first", async () => {
    await answer("p", pastTenseTask, 0, start);

    const [first, second] = fractionsTasks;
    expect((await decided(later(1))).task.id).toBe(first);

    await answer("f1", first, 1, later(2));
    expect((await decided(later(3))).task.id).toBe(second);

    await answer("f2", second, 1, later(4));
    expect((await decided(later(5))).task.id).toBe(first);
  });

  test("records a resubmitted attempt once, and grades it the same", async () => {
    const first = await answer("retry", pastTenseTask, 0, later(1));
    const again = await answer("retry", pastTenseTask, 0, later(2));

    expect(again).toEqual(first);
    // Dated by the first submission, not the retry.
    expect(await stored()).toMatchObject([{ id: `attempt:retry:${pastTense}`, at: later(1) }]);
  });

  test("refuses an attempt ID reused for a different response", async () => {
    await answer("reused", pastTenseTask, 0, later(1));

    expect(await answer("reused", pastTenseTask, 1, later(2))).toEqual({ kind: "conflict" });
    expect(await stored()).toMatchObject([{ outcome: "success" }]);
  });

  test("refuses an attempt ID reused for a different task", async () => {
    const [first, second] = fractionsTasks;
    await answer("reused", first, 0, later(1));

    expect(await answer("reused", second, 0, later(2))).toEqual({ kind: "conflict" });
    expect(await stored()).toMatchObject([{ id: `attempt:reused:${fractions}`, at: later(1) }]);
  });

  test("records one of two disagreeing submissions that arrive at once", async () => {
    // The comparison must read what is stored after inserting, as for evidence
    // (persistence/evidence.test.ts): checked first, both would pass.
    for (let race = 0; race < 10; race++) {
      await testing.clearEvidence(database, [learner]);
      const submitted = await Promise.all([
        answer("raced", pastTenseTask, 0, later(1)),
        answer("raced", pastTenseTask, 1, later(1)),
      ]);

      const kinds = submitted.map((result) => result.kind);
      expect(kinds.toSorted()).toEqual(["conflict", "graded"]);
      const winner = submitted.find((result) => result.kind === "graded");
      expect((await stored()).map((record) => record.outcome)).toEqual([
        winner?.kind === "graded" && winner.grade.outcome,
      ]);
    }
  });

  test("records a submission that races its own retry once", async () => {
    for (let race = 0; race < 10; race++) {
      await testing.clearEvidence(database, [learner]);
      const submitted = await Promise.all([
        answer("retried", pastTenseTask, 0, later(1)),
        answer("retried", pastTenseTask, 0, later(1)),
      ]);

      expect(submitted.map((result) => result.kind)).toEqual(["graded", "graded"]);
      expect(await stored()).toHaveLength(1);
    }
  });

  test("refuses a response that cannot answer the task, recording nothing", async () => {
    expect(await answer("bad", pastTenseTask, 7, start)).toEqual({ kind: "invalid" });
    expect(await stored()).toEqual([]);
  });

  test("refuses a task outside the course, and a learner outside its organization", async () => {
    expect(await answer("x1", foreignTask, 0, start)).toEqual({ kind: "unavailable" });
    expect(await answer("x2", pastTenseTask, 0, start, { learnerId: outsider })).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x3", pastTenseTask, 0, start, { course: "missing" })).toEqual({
      kind: "unavailable",
    });
    expect(await activity(start, outsider)).toEqual({ kind: "unavailable" });
    expect(await stored()).toEqual([]);
  });
});
