// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { presentTask, type TaskBody } from "../content/index.ts";
import { createCourse, createObjectives, readLearnerEvidence } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import type { RequestHost } from "./host.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "activity-test-org";
const otherOrganizationId = "activity-test-other-org";
const learner = "activity-test-learner";
/** Another member of the same organization. */
const classmate = "activity-test-classmate";
/** A member of another organization only. */
const outsider = "activity-test-outsider";
const installation: RequestHost = { hostname: "localhost", installation: true };
/** `otherOrganizationId`'s domain. */
const otherDomain: RequestHost = { hostname: "activity-test.example.com", installation: false };
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
/** A course of one task with six options: enough that orders rarely coincide. */
let shuffleCourseId!: string;
let shuffleTask!: string;
const sixOptions: TaskBody = {
  kind: "choice",
  prompt: "Which letter?",
  options: ["a", "b", "c", "d", "e", "f"],
  answer: 0,
};

function activity(now: Date, learnerId = learner, course = courseId, host = installation) {
  return chooseNextActivity({ database, learnerId, courseId: course, host, now });
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
  options: { learnerId?: string; course?: string; host?: RequestHost } = {},
) {
  return submitAttempt({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    host: options.host ?? installation,
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
      learnerIds: [learner, classmate],
      at: start,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [outsider],
      at: start,
    });
    await database
      .insert(organizationDomain)
      .values({ hostname: otherDomain.hostname, organizationId: otherOrganizationId })
      .onConflictDoNothing();

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

    const [letters] = await createObjectives(database, organizationId, ["Letters"]);
    shuffleCourseId = await createCourse(database, {
      organizationId,
      title: "Shuffle",
      objectiveIds: [letters!],
    });
    shuffleTask = await testing.createTask(database, {
      organizationId,
      objectiveId: letters!,
      body: sixOptions,
      createdAt: start,
    });

    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignTask = await testing.createTask(database, {
      organizationId: otherOrganizationId,
      objectiveId: theirs!,
      body: question("Theirs?"),
      createdAt: start,
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner, classmate, outsider]);
  });

  test("objective, task, answer, grade, evidence, next objective", async () => {
    const first = await decided(start);
    expect(first.decision).toMatchObject({ objectiveId: pastTense, intent: "introduce" });
    // The learner is shown the question, never the answer.
    expect(first.task).toEqual({
      id: pastTenseTask,
      kind: "choice",
      prompt: "Past tense?",
      // In whichever order they were shuffled into, each with its own choice.
      options: expect.arrayContaining([
        { choice: 0, text: "right" },
        { choice: 1, text: "wrong" },
      ]),
    });

    expect(await answer("a1", pastTenseTask, 1, later(1))).toEqual({
      kind: "graded",
      grade: { outcome: "failure", correctChoice: 0 },
    });
    // Its one task rests, since the learner has just been shown the answer.
    expect(await activity(later(2))).toEqual({ kind: "resting", retryAt: later(11) });
    expect((await decided(later(11))).decision).toMatchObject({
      objectiveId: pastTense,
      intent: "reteach",
    });

    await answer("a2", pastTenseTask, 0, later(12));
    // Untaught has no task, so selection moves past it rather than stopping.
    expect((await decided(later(13))).decision).toMatchObject({
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
        at: later(12),
      },
    ]);
  });

  test("keeps a task's option order across reloads, and reseeds it once answered", async () => {
    const shown = async (now: Date, learnerId = learner) => {
      const next = await activity(now, learnerId, shuffleCourseId);
      if (next.kind !== "decided") throw new Error(`Expected an activity, got "${next.kind}".`);
      return next.task.options;
    };
    // The documented seed: who, which task, and when they last answered it.
    const order = (lastAttemptAt: Date | null, learnerId = learner) =>
      presentTask(
        sixOptions,
        JSON.stringify([learnerId, shuffleTask, lastAttemptAt?.getTime() ?? null]),
      ).options;

    expect(await shown(start)).toEqual(order(null));
    expect(await shown(later(5))).toEqual(order(null));
    expect(await shown(start, classmate)).toEqual(order(null, classmate));

    // Wrongly, so the task is asked again.
    await answer("s1", shuffleTask, 1, later(5), { course: shuffleCourseId });
    expect(await shown(later(15))).toEqual(order(later(5)));
    // A resend records nothing, so it is not a new asking either.
    await answer("s1", shuffleTask, 1, later(16), { course: shuffleCourseId });
    expect(await shown(later(17))).toEqual(order(later(5)));
  });

  test("has no activity in a course with nothing to practise", async () => {
    expect(await activity(start, learner, untaughtCourseId)).toEqual({ kind: "no-activity" });
  });

  test("rotates through an objective's tasks, least recently attempted first", async () => {
    await answer("p", pastTenseTask, 0, start);

    const [first, second] = fractionsTasks;
    expect((await decided(later(1))).task.id).toBe(first);

    await answer("f1", first, 1, later(2));
    expect((await decided(later(3))).task.id).toBe(second);

    await answer("f2", second, 1, later(4));
    // Both answered within the rest, so neither is asked until the first has rested.
    expect(await activity(later(5))).toMatchObject({ kind: "resting", retryAt: later(12) });
    expect((await decided(later(12))).task.id).toBe(first);
  });

  test("refuses a new answer to a task still resting, but not a resend of the same one", async () => {
    await answer("first", pastTenseTask, 1, start);

    // Straight after seeing the answer: refused, recording nothing.
    expect(await answer("too-early", pastTenseTask, 0, later(1))).toEqual({ kind: "resting" });
    // The first attempt, resent, is the same answer rather than another one.
    expect(await answer("first", pastTenseTask, 1, later(1))).toMatchObject({ kind: "graded" });
    expect(await stored()).toMatchObject([{ id: `attempt:first:${pastTense}` }]);

    // A fresh answer once the rest is over. Were the refused attempt's row left
    // behind, this would be refused too, for coming within ten minutes of it.
    expect(await answer("after-rest", pastTenseTask, 0, later(10))).toMatchObject({
      kind: "graded",
      grade: { outcome: "success" },
    });
    expect(await stored()).toMatchObject([
      { id: `attempt:first:${pastTense}` },
      { id: `attempt:after-rest:${pastTense}` },
    ]);

    // A resend of the first, after the second: still a resend, not another
    // answer. A reuse of its ID for a different answer is still a conflict.
    expect(await answer("first", pastTenseTask, 1, later(11))).toMatchObject({ kind: "graded" });
    expect(await answer("first", pastTenseTask, 0, later(11))).toEqual({ kind: "conflict" });
  });

  test("rests a task for the learner who answered it, and nobody else", async () => {
    await answer("mine", pastTenseTask, 1, start);

    expect(await activity(later(1), classmate)).toMatchObject({
      kind: "decided",
      task: { id: pastTenseTask },
    });
    expect(
      await answer("theirs", pastTenseTask, 0, later(1), { learnerId: classmate }),
    ).toMatchObject({ kind: "graded" });
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
      await testing.clearLearnerHistory(database, [learner]);
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
      await testing.clearLearnerHistory(database, [learner]);
      const submitted = await Promise.all([
        answer("retried", pastTenseTask, 0, later(1)),
        answer("retried", pastTenseTask, 0, later(1)),
      ]);

      expect(submitted.map((result) => result.kind)).toEqual(["graded", "graded"]);
      expect(await stored()).toHaveLength(1);
    }
  });

  test("bounds attempt IDs to 1–128 characters", async () => {
    expect(await answer("", pastTenseTask, 0, start)).toEqual({ kind: "invalid" });
    expect(await answer("x".repeat(129), pastTenseTask, 0, start)).toEqual({ kind: "invalid" });
    expect((await answer("x".repeat(128), pastTenseTask, 0, start)).kind).toBe("graded");
  });

  test("refuses a response that cannot answer the task, recording nothing", async () => {
    expect(await answer("bad", pastTenseTask, 7, start)).toEqual({ kind: "invalid" });
    expect(await stored()).toEqual([]);
  });

  test("refuses a task outside the course, and a learner outside its organization", async () => {
    expect(await answer("x1", foreignTask, 0, start)).toEqual({ kind: "unavailable" });
    // The learner's organization, but a course without the task's objective.
    expect(await answer("x4", pastTenseTask, 0, start, { course: untaughtCourseId })).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x2", pastTenseTask, 0, start, { learnerId: outsider })).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x3", pastTenseTask, 0, start, { course: "missing" })).toEqual({
      kind: "unavailable",
    });
    expect(await activity(start, outsider)).toEqual({ kind: "unavailable" });
    expect(await stored()).toEqual([]);
  });

  test("serves and grades nothing on another organization's domain", async () => {
    expect(await activity(start, learner, courseId, otherDomain)).toEqual({
      kind: "unavailable",
    });
    expect(await answer("x5", pastTenseTask, 0, start, { host: otherDomain })).toEqual({
      kind: "unavailable",
    });
    expect(await stored()).toEqual([]);
  });
});
