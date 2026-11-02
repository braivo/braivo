// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { attempt, learnerEvidence, member, task } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody, TaskResponse } from "../content/index.ts";
import {
  createCourse,
  createGroup,
  createObjectives,
  type FirstAnswersScope,
  markCourseDeleted,
} from "../persistence/index.ts";
import { readFirstAnswers } from "./first-answers.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "first-answers-test-org";
const otherOrganizationId = "first-answers-test-other-org";
const learners = Array.from({ length: 7 }, (_, index) => `first-answers-test-learner-${index}`);
const [l0, l1, l2, l3, l4] = learners as [string, string, string, string, string];
const admin = "first-answers-test-admin";
const author = "first-answers-test-author";
const teacher = "first-answers-test-teacher";
const start = new Date("2026-06-01T00:00:00.000Z");
const later = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

const choice = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong", "other"],
  answer: 0,
});
const typed: TaskBody = { kind: "typed", prompt: "Ich ___ müde.", accepted: ["bin"] };

/** `main` has three tasks; `single` one; `many` six, to pool its other tasks. */
let main!: string;
let single!: string;
let many!: string;
let mainTasks!: string[];
let singleTask!: string;
let manyTasks!: string[];
let courseId!: string;
/** Another course sharing `main`, alone. */
let sharingCourseId!: string;
let foreignCourseId!: string;
let foreignObjective!: string;
let foreignTask!: string;

/**
 * Records an attempt and its evidence as `submitAttempt` writes them, at any
 * time and ID a case needs: ties and collisions included.
 */
async function record(
  learnerId: string,
  attemptId: string,
  taskId: string,
  response: TaskResponse,
  outcome: "success" | "failure",
  at: Date,
  inOrganization = organizationId,
) {
  const [{ objectiveId }] = (await database
    .select({ objectiveId: task.objectiveId })
    .from(task)
    .where(eq(task.id, taskId))) as [{ objectiveId: string }];
  await database
    .insert(attempt)
    .values({ id: attemptId, learnerId, organizationId: inOrganization, taskId, response, at });
  await database.insert(learnerEvidence).values({
    id: `attempt:${attemptId}:${objectiveId}`,
    learnerId,
    organizationId: inOrganization,
    objectiveId,
    outcome,
    at,
  });
}

const right = { choice: 0 } as const;
const wrong = { choice: 1 } as const;
const other = { choice: 2 } as const;
const reveal = { reveal: true } as const;

function read(
  scope: FirstAnswersScope,
  actingAs = admin,
  accessKind: "browser" | "tool" = "browser",
) {
  return readFirstAnswers({ database, organizationId, actingAs, accessKind, scope });
}

async function taskOf(taskId: string, scope: FirstAnswersScope = { courseId }) {
  const summary = await read(scope);
  return summary?.tasks.find(({ id }) => id === taskId);
}

/** Requires TEST_DATABASE_URL: the counts come from stored attempts. */
describe.skipIf(!connectionString)("first answers per task (progress-18)", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [...learners, author, teacher],
      adminIds: [admin],
      at: start,
    });
    await database
      .update(member)
      .set({ role: "author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author)));
    // The same people learn at another organization, under the same attempt IDs.
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: learners,
      adminIds: [admin],
      at: start,
    });

    [main, single, many] = (await createObjectives(database, organizationId, [
      "Main",
      "Single",
      "Many",
    ])) as [string, string, string];
    mainTasks = [];
    for (const body of [choice("First?"), choice("Second?"), typed]) {
      mainTasks.push(
        await testing.createTask(database, {
          organizationId,
          objectiveId: main,
          body,
          createdAt: start,
        }),
      );
    }
    singleTask = await testing.createTask(database, {
      organizationId,
      objectiveId: single,
      body: choice("Alone?"),
      createdAt: start,
    });
    manyTasks = [];
    for (let index = 0; index < 6; index++) {
      manyTasks.push(
        await testing.createTask(database, {
          organizationId,
          objectiveId: many,
          body: choice(`Many ${index}?`),
          createdAt: start,
        }),
      );
    }
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "First answers",
        objectiveIds: [main, single, many],
      })
    ).id;
    sharingCourseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Sharing",
        objectiveIds: [main],
      })
    ).id;
    await createGroup(database, {
      organizationId,
      definition: { name: "Class", learnerIds: [l0], teacherIds: [teacher], courseIds: [courseId] },
    });

    [foreignObjective] = (await createObjectives(database, otherOrganizationId, ["Theirs"])) as [
      string,
    ];
    foreignTask = await testing.createTask(database, {
      organizationId: otherOrganizationId,
      objectiveId: foreignObjective,
      body: choice("Theirs?"),
      createdAt: start,
    });
    foreignCourseId = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [foreignObjective],
      })
    ).id;
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, learners);
    await database
      .update(task)
      .set({ retiredAt: null, replacesTaskId: null })
      .where(eq(task.organizationId, organizationId));
  });

  test("counts each learner's first answer only, a reveal as revealed, options in authored order", async () => {
    const [taskId] = mainTasks as [string];
    // Wrong first, right later: incorrect.
    await record(l0, "a", taskId, wrong, "failure", later(1));
    await record(l0, "b", taskId, right, "success", later(9));
    // Show answer first, then right: revealed.
    await record(l1, "a", taskId, reveal, "failure", later(1));
    await record(l1, "b", taskId, right, "success", later(9));
    // Right first, then Show answer: correct.
    await record(l2, "a", taskId, right, "success", later(1));
    await record(l2, "b", taskId, reveal, "failure", later(9));
    // Two at one moment: the lower ID is the first, as replay orders them.
    await record(l3, "b", taskId, right, "success", later(1));
    await record(l3, "a", taskId, other, "failure", later(1));
    await record(l4, "a", taskId, right, "success", later(2));

    expect((await taskOf(taskId))?.first).toEqual({
      learners: 5,
      correct: 2,
      incorrect: 2,
      revealed: 1,
      // Revealed excluded: they add up to correct and incorrect.
      options: [2, 1, 1],
    });
  });

  test("shows nothing under 5 learners, and counts from the fifth", async () => {
    const [taskId] = mainTasks as [string];
    for (const learnerId of [l0, l1, l2, l3]) {
      await record(learnerId, "a", taskId, wrong, "failure", later(1));
    }
    // One learner's many attempts are still one learner.
    await record(l0, "b", taskId, right, "success", later(2));
    await record(l0, "c", taskId, right, "success", later(3));
    expect((await taskOf(taskId))?.first).toBeNull();

    await record(l4, "a", taskId, right, "success", later(4));
    expect((await taskOf(taskId))?.first).toMatchObject({ learners: 5, correct: 1, incorrect: 4 });
  });

  test("a typed task has no option counts", async () => {
    const typedTask = mainTasks[2]!;
    for (const [index, learnerId] of learners.slice(0, 5).entries()) {
      await record(
        learnerId,
        "a",
        typedTask,
        { text: index ? "bin" : "bist" },
        index ? "success" : "failure",
        later(1),
      );
    }
    expect((await taskOf(typedTask))?.first).toEqual({
      learners: 5,
      correct: 4,
      incorrect: 1,
      revealed: 0,
    });
  });

  test("compares with the objective's other tasks: responses pooled, learners distinct", async () => {
    const [shown, ...others] = manyTasks as [string, ...string[]];
    // One learner answering all five other tasks is one learner: under the floor.
    for (const [index, otherTask] of others.entries()) {
      await record(
        l0,
        `s${index}`,
        otherTask,
        index ? right : wrong,
        index ? "success" : "failure",
        later(index),
      );
    }
    expect((await taskOf(shown))?.otherTasks).toBeNull();

    for (const learnerId of [l1, l2, l3, l4]) {
      await record(learnerId, "a", others[0]!, reveal, "failure", later(10));
    }
    expect((await taskOf(shown))?.otherTasks).toEqual({
      responses: 9,
      learners: 5,
      correct: 4,
      incorrect: 1,
      revealed: 4,
    });
    // A task never counts among its own other tasks.
    expect((await taskOf(others[1]!))?.otherTasks).toMatchObject({ responses: 8, learners: 5 });
  });

  test("an objective with one task has no comparison", async () => {
    for (const learnerId of learners) {
      await record(learnerId, "a", singleTask, right, "success", later(1));
    }
    expect(await taskOf(singleTask)).toEqual({
      id: singleTask,
      objectiveId: single,
      first: { learners: 7, correct: 7, incorrect: 0, revealed: 0, options: [7, 0, 0] },
      otherTasks: null,
    });
  });

  test("a correction starts empty; the task it retired keeps its counts, on the objective alone", async () => {
    const [taskId] = mainTasks as [string];
    for (const learnerId of learners.slice(0, 5)) {
      await record(learnerId, "a", taskId, wrong, "failure", later(1));
    }
    const retiredAt = later(5);
    await database.update(task).set({ retiredAt }).where(eq(task.id, taskId));
    const correction = await testing.createTask(database, {
      organizationId,
      objectiveId: main,
      body: choice("First, corrected?"),
      createdAt: retiredAt,
    });
    // A draft retired unpublished has no learners' answers to keep.
    const draft = await testing.createTask(database, {
      organizationId,
      objectiveId: main,
      body: choice("Draft?"),
      createdAt: start,
      publishedAt: null,
    });
    await database
      .update(task)
      .set({ retiredAt: later(6) })
      .where(eq(task.id, draft));
    // A correction waiting for review is not asked yet.
    const pending = await testing.createTask(database, {
      organizationId,
      objectiveId: main,
      body: choice("Pending?"),
      createdAt: start,
      publishedAt: null,
    });

    try {
      const course = await read({ courseId });
      expect(course?.tasks.find(({ id }) => id === correction)?.first).toBeNull();
      expect(course?.tasks.map(({ id }) => id)).not.toContain(taskId);
      expect(course?.tasks.map(({ id }) => id)).not.toContain(pending);
      expect(course?.retired).toEqual([]);

      const objective = await read({ objectiveId: main });
      expect(objective?.retired).toEqual([
        {
          ...choice("First?"),
          id: taskId,
          objectiveId: main,
          retiredAt,
          first: { learners: 5, correct: 0, incorrect: 5, revealed: 0, options: [0, 5, 0] },
        },
      ]);
    } finally {
      await database.delete(task).where(eq(task.id, correction));
      await database.delete(task).where(eq(task.id, draft));
      await database.delete(task).where(eq(task.id, pending));
    }
  });

  test("counts an objective's attempts in every course it is in", async () => {
    const [taskId] = mainTasks as [string];
    for (const learnerId of learners.slice(0, 5)) {
      await record(learnerId, "a", taskId, right, "success", later(1));
    }
    expect(await taskOf(taskId, { courseId: sharingCourseId })).toEqual(await taskOf(taskId));
    expect(await taskOf(taskId, { objectiveId: main })).toEqual(await taskOf(taskId));
  });

  test("never mixes attempts sharing an ID across learners or organizations", async () => {
    const [taskId] = mainTasks as [string];
    // The same attempt ID for each learner; outcomes differ.
    for (const [index, learnerId] of learners.slice(0, 5).entries()) {
      await record(
        learnerId,
        "same",
        taskId,
        index < 2 ? wrong : right,
        index < 2 ? "failure" : "success",
        later(1),
      );
      // And at the other organization, failing, earlier.
      await record(learnerId, "same", foreignTask, wrong, "failure", later(0), otherOrganizationId);
    }
    expect((await taskOf(taskId))?.first).toMatchObject({ learners: 5, correct: 3, incorrect: 2 });
  });

  test("counts current members only: a removed member's answers go, and return on rejoining", async () => {
    const [taskId] = mainTasks as [string];
    for (const learnerId of learners.slice(0, 5)) {
      await record(learnerId, "a", taskId, right, "success", later(1));
    }
    const removed = await database
      .delete(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, l4)))
      .returning();
    try {
      expect((await taskOf(taskId))?.first).toBeNull();
    } finally {
      await database.insert(member).values(removed);
    }
    expect((await taskOf(taskId))?.first).toMatchObject({ learners: 5 });
  });

  test("answers only an owner or admin, in a browser", async () => {
    await testing.setToolsReadLearnerData(database, organizationId, true);
    try {
      await expect(read({ courseId }, admin, "tool")).rejects.toBeInstanceOf(NotPermitted);
    } finally {
      await testing.setToolsReadLearnerData(database, organizationId, false);
    }
    for (const reader of [author, teacher, l1, "first-answers-test-stranger"]) {
      await expect(read({ courseId }, reader)).rejects.toBeInstanceOf(NotPermitted);
    }
    // Refused before the course is looked up: one of another organization is refused alike.
    await expect(read({ courseId: foreignCourseId }, author)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("finds nothing of another organization under this one", async () => {
    expect(await read({ courseId: foreignCourseId })).toBeUndefined();
    expect(await read({ objectiveId: foreignObjective })).toBeUndefined();
    expect(await read({ courseId: "missing" })).toBeUndefined();
  });

  test("finds nothing of a deleted course, as every course read", async () => {
    const { id } = await createCourse(database, {
      organizationId,
      title: "Deleted",
      published: false,
      objectiveIds: [main],
    });
    expect(await read({ courseId: id })).toBeDefined();
    await markCourseDeleted(database, { organizationId, courseId: id, now: start });
    expect(await read({ courseId: id })).toBeUndefined();
  });
});
