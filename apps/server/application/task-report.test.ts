// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase, runMigrations } from "@braivo/db";
import { attempt, member, task, taskReport, user } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody, TaskResponse } from "../content/index.ts";
import { createCourse, createGroup, createObjectives } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import { publish } from "./courses.ts";
import type { RequestHost } from "./host.ts";
import { NotPermitted } from "./permission.ts";
import {
  dismissReports,
  listReportedTasks,
  parseTaskReport,
  reportAttempt,
  type TaskReportInput,
} from "./task-report.ts";
import { defineTasks, retireTasks } from "./tasks.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "task-report-test-org";
const otherOrganizationId = "task-report-test-other-org";
const learner = "task-report-test-learner";
const classmate = "task-report-test-classmate";
/** A member of the other organization only. */
const outsider = "task-report-test-outsider";
/** Administers the organization: reads and dismisses its reports. */
const admin = "task-report-test-admin";
/** Authors in it, and administers nothing. */
const author = "task-report-test-author";
/** Teaches a group taking the course, and holds no other role. */
const teacher = "task-report-test-teacher";
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
    historyEpoch: 0,
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
      learnerIds: [learner, classmate, author, teacher],
      adminIds: [admin],
      at: start,
    });
    await database
      .update(member)
      .set({ role: "author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author)));
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
        historyEpoch: 0,
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

describe.skipIf(!connectionString)("the school reading and resolving reports (access-46)", () => {
  /** A task of a new objective in a new published course, answered wrong by each of `learners`. */
  async function reportedTask(
    learners: readonly string[],
    { reason = keyWrong, now = later(100) }: { reason?: TaskReportInput; now?: Date } = {},
  ) {
    const [objectiveId] = await createObjectives(database, organizationId, [
      `Reported ${crypto.randomUUID()}`,
    ]);
    const taskId = await testing.createTask(database, {
      organizationId,
      objectiveId: objectiveId!,
      body: choice("Reported?"),
      createdAt: start,
    });
    const course = await createCourse(database, {
      published: true,
      organizationId,
      title: "Reported course",
      objectiveIds: [objectiveId!],
    });
    for (const learnerId of learners) {
      const attemptId = `${taskId}:${learnerId}`;
      await answer(attemptId, taskId, { choice: 1 }, later(1), { learnerId, course: course.id });
      await report(attemptId, reason, { learnerId, course: course.id, now });
    }
    return { objectiveId: objectiveId!, taskId, courseId: course.id };
  }

  /** `count` reports of one task by learners made for it, stored directly, a minute apart. */
  async function manyReports(taskId: string, count: number) {
    const people = Array.from({ length: count }, (_, index) => `task-report-test-many-${index}`);
    await database
      .insert(user)
      .values(
        people.map((id) => ({
          id,
          name: id,
          email: `${id}@example.com`,
          emailVerified: false,
          createdAt: start,
          updatedAt: start,
        })),
      )
      .onConflictDoNothing();
    const attempts = people.map((learnerId) => ({
      learnerId,
      organizationId,
      id: `${taskId}:${learnerId}`,
      taskId,
      response: { choice: 1 },
      at: start,
    }));
    await database.insert(attempt).values(attempts);
    await database.insert(taskReport).values(
      attempts.map(({ learnerId, id }, index) => ({
        learnerId,
        organizationId,
        attemptId: id,
        id: crypto.randomUUID(),
        taskId,
        reason: "confusing" as const,
        createdAt: later(index),
      })),
    );
  }

  const list = (scope: Parameters<typeof listReportedTasks>[0]["scope"] = {}, actingAs = admin) =>
    listReportedTasks({ database, organizationId, actingAs, accessKind: "browser", scope });
  const dismiss = (reportIds: string[], actingAs = admin) =>
    dismissReports({
      database,
      organizationId,
      actingAs,
      accessKind: "browser",
      reportIds,
      now: later(500),
    });
  const reportedIds = async (scope: Parameters<typeof list>[0] = {}) =>
    (await list(scope)).tasks.map(({ id }) => id);

  beforeAll(async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Taught"]);
    const { id: taughtCourse } = await createCourse(database, {
      published: true,
      organizationId,
      title: "Taught",
      objectiveIds: [objectiveId!],
    });
    await createGroup(database, {
      organizationId,
      definition: {
        name: "Class",
        learnerIds: [learner],
        teacherIds: [teacher],
        courseIds: [taughtCourse],
      },
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner, classmate]);
  });

  test("lists open reports per task, counted, with what each learner answered and wrote, naming no one", async () => {
    await answer("a1", choiceTasks[0]!, { choice: 1 }, later(1));
    await report("a1", { reason: "confusing", note: "Which one?" }, { now: later(10) });
    await answer("c1", choiceTasks[0]!, { reveal: true }, later(2), { learnerId: classmate });
    await report("c1", keyWrong, { learnerId: classmate, now: later(20) });

    const { tasks, more } = await list({ taskId: choiceTasks[0]! });

    expect(more).toBe(false);
    expect(tasks).toEqual([
      {
        id: choiceTasks[0],
        objectiveId: objectives[0],
        kind: "choice",
        prompt: "Question 1?",
        options: ["right", "wrong"],
        answer: 0,
        reportCount: 2,
        reasonCount: 2,
        reports: [
          {
            id: expect.any(String),
            reason: "key-wrong",
            at: later(20),
            response: { reveal: true },
          },
          {
            id: expect.any(String),
            reason: "confusing",
            note: "Which one?",
            at: later(10),
            response: { choice: 1 },
          },
        ],
      },
    ]);
    // Nothing about who: the keys are these alone.
    expect(Object.keys(tasks[0]!.reports[0]!).sort()).toEqual(["at", "id", "reason", "response"]);
    expect(JSON.stringify(tasks)).not.toContain(learner);
    expect(JSON.stringify(tasks)).not.toContain(classmate);
  });

  test("lists the newest reported task first, scoped to an objective, a course, or a task", async () => {
    const first = await reportedTask([learner], { now: later(100) });
    const second = await reportedTask([classmate], { now: later(101) });

    const ids = await reportedIds();
    expect(ids.indexOf(second.taskId)).toBeLessThan(ids.indexOf(first.taskId));
    expect(await reportedIds({ objectiveId: first.objectiveId })).toEqual([first.taskId]);
    expect(await reportedIds({ courseId: second.courseId })).toEqual([second.taskId]);
    expect(await reportedIds({ taskId: first.taskId })).toEqual([first.taskId]);
    expect(await reportedIds({ courseId: "no-such-course" })).toEqual([]);
  });

  test("closes a task's reports once it is retired", async () => {
    const { taskId } = await reportedTask([learner]);

    await retireTasks({
      database,
      organizationId,
      actingAs: admin,
      taskIds: [taskId],
      now: later(30),
      byTool: false,
    });

    expect(await reportedIds({ taskId })).toEqual([]);
  });

  test("closes reports on the console's correction at once, and on a tool's once published, naming it meanwhile", async () => {
    const corrected = await reportedTask([learner]);
    const correct = (taskId: string, objectiveId: string, prompt: string, byTool: boolean) =>
      defineTasks({
        database,
        organizationId,
        actingAs: admin,
        tasks: [{ objectiveId, body: choice(prompt), replaces: taskId }],
        now: later(40),
        byTool,
      });

    await correct(corrected.taskId, corrected.objectiveId, "Corrected?", false);
    expect(await reportedIds({ taskId: corrected.taskId })).toEqual([]);

    const { taskId, objectiveId } = await reportedTask([classmate]);
    const [first] = await correct(taskId, objectiveId, "Proposed?", true);
    expect((await list({ taskId })).tasks[0]?.pendingCorrectionId).toBe(first!.id);
    // A tool editing its pending correction replaces it: the report names the new one.
    const [second] = await defineTasks({
      database,
      organizationId,
      actingAs: admin,
      tasks: [{ objectiveId, body: choice("Proposed again?"), replaces: first!.id }],
      now: later(41),
      byTool: true,
    });
    expect((await list({ taskId })).tasks[0]?.pendingCorrectionId).toBe(second!.id);

    await publish({
      database,
      organizationId,
      actingAs: admin,
      courseIds: [],
      taskIds: [second!.id],
      now: later(42),
    });
    expect(await reportedIds({ taskId })).toEqual([]);
  });

  test("forgets a pending correction once it is retired, the report open", async () => {
    const { taskId, objectiveId } = await reportedTask([learner]);
    const [proposal] = await defineTasks({
      database,
      organizationId,
      actingAs: admin,
      tasks: [{ objectiveId, body: choice("Proposed?"), replaces: taskId }],
      now: later(40),
      byTool: true,
    });

    await retireTasks({
      database,
      organizationId,
      actingAs: admin,
      taskIds: [proposal!.id],
      now: later(41),
      byTool: true,
    });

    const [listed] = (await list({ taskId })).tasks;
    expect(listed?.id).toBe(taskId);
    expect(listed).not.toHaveProperty("pendingCorrectionId");
  });

  test("dismisses exactly the reports shown, keeping who did it first, and leaves later ones open", async () => {
    const { taskId, courseId } = await reportedTask([learner]);
    const shown = (await list({ taskId })).tasks[0]!.reports.map(({ id }) => id);
    // Sent after the reviewer read the page.
    await answer("late", taskId, { choice: 1 }, later(2), {
      learnerId: classmate,
      course: courseId,
    });
    await report("late", keyWrong, { learnerId: classmate, course: courseId });

    await dismiss(shown);
    // A retry, by another administrator say, changes nothing.
    await dismissReports({
      database,
      organizationId,
      actingAs: admin,
      accessKind: "browser",
      reportIds: shown,
      now: later(900),
    });

    const [left] = (await list({ taskId })).tasks;
    expect(left?.reportCount).toBe(1);
    expect(left?.reports.map(({ id }) => id)).not.toContain(shown[0]);
    const [dismissed] = await database
      .select({ by: taskReport.dismissedBy, at: taskReport.dismissedAt })
      .from(taskReport)
      .where(eq(taskReport.id, shown[0]!));
    expect(dismissed).toEqual({ by: admin, at: later(500) });
  });

  test("lists 20 reports beside a task and every one by its ID, up to 1000", async () => {
    const { taskId } = await reportedTask([]);
    await manyReports(taskId, 1001);

    const [preview] = (await list()).tasks.filter(({ id }) => id === taskId);
    expect(preview?.reportCount).toBe(1001);
    expect(preview?.reports).toHaveLength(20);

    const [whole] = (await list({ taskId })).tasks;
    expect(whole?.reports).toHaveLength(1000);
    await dismiss(whole!.reports.map(({ id }) => id));

    // The oldest, beyond the first thousand, is left, and listed now.
    const [rest] = (await list({ taskId })).tasks;
    expect(rest?.reportCount).toBe(1);
    expect(rest?.reports).toHaveLength(1);
  });

  test("counts the reasons of every open report, not only the 20 listed", async () => {
    const { taskId, objectiveId } = await reportedTask([]);
    await manyReports(taskId, 21);
    // The newest 20 say the key is wrong; the oldest alone, that it is confusing.
    await database
      .update(taskReport)
      .set({ reason: "key-wrong" })
      .where(and(eq(taskReport.taskId, taskId), gt(taskReport.createdAt, later(0))));

    const [listed] = (await list({ taskId })).tasks;
    expect(listed?.reasonCount).toBe(2);
    const [preview] = (await list({ objectiveId })).tasks;
    expect(preview?.reports).toHaveLength(20);
    expect(preview?.reports.every(({ reason }) => reason === "key-wrong")).toBe(true);
    expect(preview?.reportCount).toBe(21);
    expect(preview?.reasonCount).toBe(2);

    const [oldest] = await database
      .select({ id: taskReport.id })
      .from(taskReport)
      .where(and(eq(taskReport.taskId, taskId), eq(taskReport.reason, "confusing")));
    await dismiss([oldest!.id]);
    expect((await list({ taskId })).tasks[0]?.reasonCount).toBe(1);
  });

  test("lists every reported task of a course or an objective, and the organization's newest 100", async () => {
    const { objectiveId, courseId: reportedCourse, taskId } = await reportedTask([learner]);
    const others = await Promise.all(
      Array.from({ length: 100 }, () =>
        testing.createTask(database, {
          organizationId,
          objectiveId,
          body: choice("Another?"),
          createdAt: start,
        }),
      ),
    );
    const attempts = others.map((id) => ({
      learnerId: learner,
      organizationId,
      id: `${id}:${learner}`,
      taskId: id,
      response: { choice: 1 },
      at: start,
    }));
    await database.insert(attempt).values(attempts);
    await database.insert(taskReport).values(
      attempts.map(({ id, taskId: reported }) => ({
        learnerId: learner,
        organizationId,
        attemptId: id,
        id: crypto.randomUUID(),
        taskId: reported,
        reason: "confusing" as const,
        createdAt: later(200),
      })),
    );

    for (const scope of [{ objectiveId }, { courseId: reportedCourse }]) {
      const { tasks, more } = await list(scope);
      expect(tasks).toHaveLength(101);
      expect(more).toBe(false);
    }
    const organizationWide = await list();
    expect(organizationWide.tasks).toHaveLength(100);
    expect(organizationWide.more).toBe(true);
    // The oldest reported, left out there, is still on its page.
    expect(organizationWide.tasks.map(({ id }) => id)).not.toContain(taskId);
  });

  test("counts and lists a task's reports in one snapshot, a dismissal meanwhile in neither", async () => {
    const { taskId } = await reportedTask([learner]);
    const shown = (await list({ taskId })).tasks[0]!.reports.map(({ id }) => id);

    // Holds the read between its count and its reports: only the reports read attempts.
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const lock = database.transaction(async (transaction) => {
      await transaction.execute(sql`lock table ${attempt} in access exclusive mode`);
      locked();
      await released;
    });
    // Its own connection, named, so the wait found is this read's, not another suite's.
    const url = new URL(connectionString ?? "");
    url.searchParams.set("application_name", "task-report-snapshot-test");
    const reader = createDatabase(url.toString());
    try {
      await isLocked;
      const reading = listReportedTasks({
        database: reader,
        organizationId,
        actingAs: admin,
        accessKind: "browser",
        scope: { taskId },
      });
      for (;;) {
        const [waiting] = await database.execute<{ count: number }>(
          sql`select count(*)::int as count from pg_stat_activity
              where application_name = 'task-report-snapshot-test' and wait_event_type = 'Lock'`,
          "objects",
        );
        if (waiting!.count > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await dismiss(shown);
      release();
      await lock;

      const [read] = (await reading).tasks;
      expect(read?.reportCount).toBe(1);
      expect(read?.reports.map(({ id }) => id)).toEqual(shown);
    } finally {
      release();
      await lock;
      await reader.$client.end();
    }
    expect(await reportedIds({ taskId })).toEqual([]);
  });

  test("refuses whoever does not administer, and any tool, whatever the organization lets tools read", async () => {
    const { taskId } = await reportedTask([learner]);
    const [reportId] = (await list({ taskId })).tasks[0]!.reports.map(({ id }) => id);

    for (const actingAs of [author, teacher, learner, outsider]) {
      await expect(list({}, actingAs)).rejects.toBeInstanceOf(NotPermitted);
      await expect(dismiss([reportId!], actingAs)).rejects.toBeInstanceOf(NotPermitted);
    }
    for (const allowed of [false, true]) {
      await testing.setToolsReadLearnerData(database, organizationId, allowed);
      await expect(
        listReportedTasks({
          database,
          organizationId,
          actingAs: admin,
          accessKind: "tool",
          scope: {},
        }),
      ).rejects.toBeInstanceOf(NotPermitted);
      await expect(
        dismissReports({
          database,
          organizationId,
          actingAs: admin,
          accessKind: "tool",
          reportIds: [reportId!],
          now: later(500),
        }),
      ).rejects.toBeInstanceOf(NotPermitted);
    }
    await testing.setToolsReadLearnerData(database, organizationId, false);
    expect(await reportedIds({ taskId })).toEqual([taskId]);
  });

  test("refuses to dismiss another organization's report or an unknown one, dismissing nothing", async () => {
    const { taskId } = await reportedTask([learner]);
    const [mine] = (await list({ taskId })).tasks[0]!.reports.map(({ id }) => id);
    await answer("f1", foreignTask, { choice: 1 }, later(1), { course: foreignCourseId });
    await reportAttempt({
      database,
      learnerId: learner,
      courseId: foreignCourseId,
      host: installation,
      attemptId: "f1",
      report: keyWrong,
      now: later(5),
    });
    const [theirs] = await database
      .select({ id: taskReport.id })
      .from(taskReport)
      .where(eq(taskReport.organizationId, otherOrganizationId));

    await expect(dismiss([mine!, theirs!.id])).rejects.toBeInstanceOf(NotPermitted);
    await expect(dismiss([mine!, "no-such-report"])).rejects.toBeInstanceOf(NotPermitted);
    expect(await reportedIds({ taskId })).toEqual([taskId]);
  });
});
