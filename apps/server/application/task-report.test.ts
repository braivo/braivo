// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { attempt, member, task, taskReport, user } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody, TaskResponse } from "../content/index.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import type { RequestHost } from "./host.ts";
import { parseTaskReport, reportAttempt, type TaskReportInput } from "./task-report.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "task-report-test-org";
const otherOrganizationId = "task-report-test-other-org";
const learner = "task-report-test-learner";
const classmate = "task-report-test-classmate";
/** A member of the other organization only. */
const outsider = "task-report-test-outsider";
const installation: RequestHost = { hostname: "localhost", installation: true };
const start = new Date("2026-06-01T00:00:00.000Z");
const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

const choice = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong"],
  answer: 0,
});

/** Four objectives of one choice task each, then one with a typed task. */
let objectives!: string[];
let choiceTasks!: string[];
let typedTask!: string;
let courseId!: string;
/** The organization's course without the first objective. */
let narrowCourseId!: string;
let foreignCourseId!: string;
let foreignTask!: string;

/** Answers a task as `learnerId`, at `now`, under `attemptId`. */
async function answer(
  attemptId: string,
  taskId: string,
  response: TaskResponse,
  now: Date,
  options: { learnerId?: string; course?: string } = {},
) {
  const submitted = await submitAttempt({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    host: installation,
    attemptId,
    taskId,
    response,
    now,
  });
  if (submitted.kind !== "graded") throw new Error(`Expected a grade, got "${submitted.kind}".`);
  return submitted.grade;
}

function report(
  attemptId: string,
  input: TaskReportInput,
  options: { learnerId?: string; course?: string; now?: Date } = {},
) {
  return reportAttempt({
    database,
    learnerId: options.learnerId ?? learner,
    courseId: options.course ?? courseId,
    host: installation,
    attemptId,
    report: input,
    now: options.now ?? later(100),
  });
}

/** Every report stored for the learner, oldest first. */
function storedReports(learnerId = learner) {
  return database
    .select({
      attemptId: taskReport.attemptId,
      taskId: taskReport.taskId,
      reason: taskReport.reason,
      note: taskReport.note,
      dismissedAt: taskReport.dismissedAt,
    })
    .from(taskReport)
    .where(eq(taskReport.learnerId, learnerId))
    .orderBy(taskReport.createdAt, taskReport.attemptId);
}

const keyWrong: TaskReportInput = { reason: "key-wrong" };

/** Requires TEST_DATABASE_URL: what is stored and refused is the point. */
describe.skipIf(!connectionString)("a learner reporting a task (learner-loop-22)", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner, classmate],
      at: start,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [outsider, learner],
      at: start,
    });

    objectives = await createObjectives(database, organizationId, [
      "One",
      "Two",
      "Three",
      "Four",
      "Typed",
    ]);
    choiceTasks = [];
    for (const [index, objectiveId] of objectives.slice(0, 4).entries()) {
      choiceTasks.push(
        await testing.createTask(database, {
          organizationId,
          objectiveId,
          body: choice(`Question ${index + 1}?`),
          createdAt: start,
        }),
      );
    }
    typedTask = await testing.createTask(database, {
      organizationId,
      objectiveId: objectives[4]!,
      body: { kind: "typed", prompt: "I am tired: Ich ___ müde.", accepted: ["bin"] },
      createdAt: start,
    });
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Reported",
        objectiveIds: objectives,
      })
    ).id;
    narrowCourseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Narrow",
        objectiveIds: objectives.slice(1),
      })
    ).id;

    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignTask = await testing.createTask(database, {
      organizationId: otherOrganizationId,
      objectiveId: theirs!,
      body: choice("Theirs?"),
      createdAt: start,
    });
    foreignCourseId = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [theirs!],
      })
    ).id;
  });

  beforeEach(async () => {
    // Reports go with the attempts they are about.
    await testing.clearLearnerHistory(database, [learner, classmate, outsider]);
    await database
      .update(task)
      .set({ retiredAt: null })
      .where(eq(task.organizationId, organizationId));
  });

  test("stores a report of the learner's own attempt, and answers a resend with it", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));

    expect(await report("a1", { reason: "confusing", note: "Which tense?" })).toEqual({
      kind: "stored",
      created: true,
      report: { reason: "confusing", note: "Which tense?", at: later(100) },
    });
    // Sent again later, it answers what was stored, dated when it first was.
    expect(
      await report("a1", { reason: "confusing", note: "Which tense?" }, { now: later(200) }),
    ).toEqual({
      kind: "stored",
      created: false,
      report: { reason: "confusing", note: "Which tense?", at: later(100) },
    });
    expect(await storedReports()).toEqual([
      {
        attemptId: "a1",
        taskId: choiceTasks[0],
        reason: "confusing",
        note: "Which tense?",
        dismissedAt: null,
      },
    ]);
  });

  test("never changes a report: another for that attempt, or any while one of the task's is undismissed, is refused", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    // Rested: three attempts on other objectives end it.
    await answer("b1", choiceTasks[1]!, { choice: 0 }, later(2));
    await answer("b2", choiceTasks[2]!, { choice: 0 }, later(3));
    await answer("b3", choiceTasks[3]!, { choice: 0 }, later(4));
    await answer("a2", choiceTasks[0]!, { choice: 0 }, later(5));

    expect((await report("a1", keyWrong)).kind).toBe("stored");
    expect(await report("a1", { reason: "confusing" })).toEqual({ kind: "already-reported" });
    expect(await report("a1", { reason: "key-wrong", note: "Also this" })).toEqual({
      kind: "already-reported",
    });
    expect(await report("a2", keyWrong)).toEqual({ kind: "already-reported" });
    // Another learner's report of the same task is theirs alone.
    await answer("c1", choiceTasks[0]!, { choice: 1 }, later(1), { learnerId: classmate });
    expect((await report("c1", keyWrong, { learnerId: classmate })).kind).toBe("stored");

    // Dismissed, the learner may report the task again, from another attempt.
    await database
      .update(taskReport)
      .set({ dismissedAt: later(150) })
      .where(and(eq(taskReport.learnerId, learner), eq(taskReport.attemptId, "a1")));
    expect((await report("a2", { reason: "confusing" })).kind).toBe("stored");
    expect(await report("a1", keyWrong)).toEqual({
      kind: "stored",
      created: false,
      report: { reason: "key-wrong", at: later(100) },
    });
  });

  test("stores one of two reports racing on one task", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    await answer("b1", choiceTasks[1]!, { choice: 0 }, later(2));
    await answer("b2", choiceTasks[2]!, { choice: 0 }, later(3));
    await answer("b3", choiceTasks[3]!, { choice: 0 }, later(4));
    await answer("a2", choiceTasks[0]!, { choice: 1 }, later(5));

    const answers = await Promise.all([report("a1", keyWrong), report("a2", keyWrong)]);
    expect(answers.map(({ kind }) => kind).sort()).toEqual(["already-reported", "stored"]);
    expect(await storedReports()).toHaveLength(1);
  });

  test("lets a learner cycling through tasks as fast as they may hold one open report per task", async () => {
    // Four objectives answered in turn: each task's rest ends after three
    // attempts elsewhere, so every task comes back each round.
    for (let round = 0; round < 3; round++) {
      for (const [index, taskId] of choiceTasks.entries()) {
        const attemptId = `r${round}-${index}`;
        await answer(attemptId, taskId, { choice: 1 }, later(round * 4 + index));
        await report(attemptId, keyWrong);
      }
    }

    const open = await database
      .select({ taskId: taskReport.taskId })
      .from(taskReport)
      .where(and(eq(taskReport.learnerId, learner), isNull(taskReport.dismissedAt)));
    expect(open.map(({ taskId }) => taskId).sort()).toEqual([...choiceTasks].sort());
  });

  test("answers an attempt that is not the learner's, or not of the course, as missing", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    await answer("c1", choiceTasks[0]!, { choice: 1 }, later(1), { learnerId: classmate });
    await answer("f1", foreignTask, { choice: 1 }, later(1), { course: foreignCourseId });

    const missing = { kind: "unavailable" };
    // Another learner's attempt, under its own ID.
    expect(await report("c1", keyWrong)).toEqual(missing);
    // One that does not exist.
    expect(await report("nobody", keyWrong)).toEqual(missing);
    // The learner's own, at another organization, named through this course.
    expect(await report("f1", keyWrong)).toEqual(missing);
    // A course whose objectives do not include the task.
    expect(await report("a1", keyWrong, { course: narrowCourseId })).toEqual(missing);
    // A course of an organization the learner is not in.
    expect(await report("a1", keyWrong, { learnerId: outsider })).toEqual(missing);
    expect(await report("a1", keyWrong, { course: "no-such-course" })).toEqual(missing);
    expect(await storedReports()).toEqual([]);
    expect(await storedReports(outsider)).toEqual([]);
  });

  test("accepts My answer seems correct only after a miss that was not Show answer", async () => {
    await answer("miss", choiceTasks[0]!, { choice: 1 }, later(1));
    await answer("hit", choiceTasks[1]!, { choice: 0 }, later(2));
    await answer("shown", choiceTasks[2]!, { reveal: true }, later(3));
    await answer("typed-miss", typedTask, { text: "bist" }, later(4));

    const answerCorrect: TaskReportInput = { reason: "answer-correct" };
    expect(await report("hit", answerCorrect)).toEqual({ kind: "invalid" });
    expect(await report("shown", answerCorrect)).toEqual({ kind: "invalid" });
    expect((await report("miss", answerCorrect)).kind).toBe("stored");
    expect((await report("typed-miss", answerCorrect)).kind).toBe("stored");
    // Every other reason, after any answer.
    expect((await report("hit", { reason: "unsupported" })).kind).toBe("stored");
    expect((await report("shown", { reason: "other", note: "No options" })).kind).toBe("stored");
  });

  test("parses a report's body, refusing what it cannot store", () => {
    expect(parseTaskReport({ reason: "key-wrong" })).toEqual({ reason: "key-wrong" });
    expect(parseTaskReport({ reason: "other", note: " Typo " })).toEqual({
      reason: "other",
      note: "Typo",
    });
    // A blank note is no note.
    expect(parseTaskReport({ reason: "confusing", note: "  " })).toEqual({ reason: "confusing" });
    expect(parseTaskReport({ reason: "confusing", note: "x".repeat(500) })).toEqual({
      reason: "confusing",
      note: "x".repeat(500),
    });

    for (const body of [
      null,
      "key-wrong",
      {},
      { reason: "wrong" },
      { reason: "other" },
      { reason: "other", note: " " },
      { reason: "confusing", note: "x".repeat(501) },
      { reason: "confusing", note: 5 },
      { reason: "confusing", note: "half \uD800" },
      { reason: "confusing", note: null },
    ]) {
      expect(parseTaskReport(body), JSON.stringify(body)).toBeUndefined();
    }
  });

  test("stores a report of a task retired since, and refuses another attempt's of it", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    await answer("b1", choiceTasks[1]!, { choice: 0 }, later(2));
    await answer("b2", choiceTasks[2]!, { choice: 0 }, later(3));
    await answer("b3", choiceTasks[3]!, { choice: 0 }, later(4));
    await answer("a2", choiceTasks[0]!, { choice: 1 }, later(5));
    await database
      .update(task)
      .set({ retiredAt: later(6) })
      .where(eq(task.id, choiceTasks[0]!));

    expect((await report("a1", keyWrong)).kind).toBe("stored");
    expect(await report("a2", { reason: "confusing" })).toEqual({ kind: "already-reported" });
  });

  test("changes nothing about practice: the attempt, its evidence, the rest, and the order shown", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    const practice = async () => ({
      attempts: await database.select().from(attempt).where(eq(attempt.learnerId, learner)),
      evidence: await testing.readStoredEvidence(database, learner),
      next: await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now: later(2),
        timeZone: "UTC",
      }),
    });
    const before = await practice();

    await report("a1", keyWrong, { now: later(1) });

    expect(await practice()).toEqual(before);
    // Still resting for the learner, as before reporting.
    await expect(
      submitAttempt({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        attemptId: "a2",
        taskId: choiceTasks[0]!,
        response: { choice: 0 },
        now: later(2),
      }),
    ).resolves.toEqual({ kind: "resting" });
  });

  test("goes with the learner's account", async () => {
    const leaver = "task-report-test-leaver";
    await database
      .insert(user)
      .values({
        id: leaver,
        name: leaver,
        email: `${leaver}@example.com`,
        emailVerified: false,
        createdAt: start,
        updatedAt: start,
      })
      .onConflictDoNothing();
    await database
      .insert(member)
      .values({
        id: `${organizationId}:${leaver}`,
        organizationId,
        userId: leaver,
        role: "member",
        createdAt: start,
      })
      .onConflictDoNothing();
    await answer("l1", choiceTasks[0]!, { choice: 1 }, later(1), { learnerId: leaver });
    expect((await report("l1", keyWrong, { learnerId: leaver })).kind).toBe("stored");

    await database.delete(user).where(eq(user.id, leaver));

    expect(await storedReports(leaver)).toEqual([]);
  });
});
