// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import {
  createCourse,
  createObjectives,
  createTasks,
  markTasksRetired,
} from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import { listLearnerCoursesWithStanding } from "./courses.ts";
import type { RequestHost } from "./host.ts";

/**
 * A card must not promise practice its tap would not give: what waits leaves out
 * what rests, by practice's own rule (learner-loop-7, learner-loop-27). Real
 * attempts, then the list and the activity at the same moment.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "waiting-rests-test-org";
const otherOrganizationId = "waiting-rests-test-other-org";
const host: RequestHost = { hostname: "localhost", installation: true };
const start = new Date("2026-06-01T12:00:00.000Z");
const minutes = (count: number) => new Date(start.getTime() + count * 60_000);

/** Answers 0 right. */
const question: TaskBody = { kind: "choice", prompt: "?", options: ["right", "wrong"], answer: 0 };
const RIGHT = { choice: 0 };
const WRONG = { choice: 1 };

let seededLearners = 0;

/** A learner of their own, a member of both organizations. */
async function newLearner() {
  const learnerId = `waiting-rests-test-learner-${seededLearners++}`;
  for (const id of [organizationId, otherOrganizationId]) {
    await testing.seedOrganization(database, {
      organizationId: id,
      learnerIds: [learnerId],
      at: start,
    });
  }
  return learnerId;
}

/** A course of `tasksPerObjective.length` objectives, each with so many tasks. */
async function course(title: string, tasksPerObjective: number[], organization = organizationId) {
  const objectiveIds = await createObjectives(
    database,
    organization,
    tasksPerObjective.map((_unused, index) => `${title} ${index}`),
  );
  const tasks: string[][] = [];
  for (const [index, count] of tasksPerObjective.entries()) {
    const written = await createTasks(
      database,
      organization,
      Array.from({ length: count }, (_unused, number) => ({
        objectiveId: objectiveIds[index]!,
        body: { ...question, prompt: `${title} ${index} ${number}` },
      })),
      start,
      { published: true },
    );
    tasks.push(written.map(({ id }) => id));
  }
  const { id } = await createCourse(database, {
    published: true,
    organizationId: organization,
    title,
    objectiveIds,
  });
  return { id, tasks };
}

describe.skipIf(!connectionString)("what waits in a course, while tasks rest", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  const answer = (
    learnerId: string,
    courseId: string,
    taskId: string,
    response: object,
    at: Date,
  ) =>
    submitAttempt({
      database,
      historyEpoch: 0,
      reviewedTeaching: false,
      learnerId,
      courseId,
      host,
      attemptId: `${taskId}@${at.toISOString()}`,
      taskId,
      response,
      now: at,
    });

  /** What the list says waits in `courseId` at `now`, and what its activity then does. */
  async function read(learnerId: string, courseId: string, now: Date) {
    const listed = await listLearnerCoursesWithStanding({
      database,
      learnerId,
      host,
      now,
      timeZone: "UTC",
    });
    const next = await chooseNextActivity({
      database,
      learnerId,
      courseId,
      host,
      now,
      timeZone: "UTC",
    });
    return {
      waiting: listed.find(({ id }) => id === courseId)!.waiting,
      activity: next.kind === "decided" ? next.decision.intent : next.kind,
    };
  }

  test("does not count a missed objective while it rests, and counts it after", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("One miss", [1]);
    await answer(learnerId, id, tasks[0]![0]!, WRONG, minutes(0));
    const nothing = { learning: 0, dueForReview: 0, new: 0 };

    // At once, and to the last moment of the rest: the tap would only say when.
    expect(await read(learnerId, id, minutes(0))).toEqual({
      waiting: nothing,
      activity: "resting",
    });
    expect(await read(learnerId, id, new Date(minutes(10).getTime() - 1))).toEqual({
      waiting: nothing,
      activity: "resting",
    });
    // Then it waits, and the tap offers it.
    expect(await read(learnerId, id, minutes(10))).toEqual({
      waiting: { ...nothing, learning: 1 },
      activity: "reteach",
    });
  });

  test("still counts what else the course can offer meanwhile", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("Others meanwhile", [1, 1]);
    await answer(learnerId, id, tasks[0]![0]!, WRONG, minutes(0));

    expect(await read(learnerId, id, minutes(1))).toEqual({
      waiting: { learning: 0, dueForReview: 0, new: 1 },
      activity: "introduce",
    });
  });

  test("counts a missed objective whose other task can be offered", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("Another task", [2]);
    await answer(learnerId, id, tasks[0]![0]!, WRONG, minutes(0));

    expect(await read(learnerId, id, minutes(1))).toEqual({
      waiting: { learning: 1, dueForReview: 0, new: 0 },
      activity: "reteach",
    });
    // Both answered: now every task rests.
    await answer(learnerId, id, tasks[0]![1]!, WRONG, minutes(2));
    expect(await read(learnerId, id, minutes(3))).toEqual({
      waiting: { learning: 0, dueForReview: 0, new: 0 },
      activity: "resting",
    });
  });

  test("counts it once three attempts on other objectives end the rest, at this organization alone", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("Three others", [1, 1, 1, 1]);
    const elsewhere = await course("Elsewhere", [1, 1, 1], otherOrganizationId);
    await answer(learnerId, id, tasks[0]![0]!, WRONG, minutes(0));
    // A snapshot of what a tap offers now, not a session's length: answering
    // these three ends the miss's rest, and it waits too.
    expect((await read(learnerId, id, minutes(0))).waiting).toEqual({
      learning: 0,
      dueForReview: 0,
      new: 3,
    });

    // Another organization's attempts space nothing out here.
    for (const [index, objective] of elsewhere.tasks.entries()) {
      await answer(learnerId, elsewhere.id, objective[0]!, RIGHT, minutes(1 + index));
    }
    expect((await read(learnerId, id, minutes(4))).waiting.learning).toBe(0);

    await answer(learnerId, id, tasks[1]![0]!, RIGHT, minutes(5));
    await answer(learnerId, id, tasks[2]![0]!, RIGHT, minutes(6));
    expect((await read(learnerId, id, minutes(6))).waiting.learning).toBe(0);
    await answer(learnerId, id, tasks[3]![0]!, RIGHT, minutes(7));
    expect(await read(learnerId, id, minutes(7))).toEqual({
      waiting: { learning: 1, dueForReview: 0, new: 0 },
      activity: "reteach",
    });
  });

  test("does not end a rest by attempts at the same moment as its own", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("Same moment", [1, 1, 1, 1]);
    await answer(learnerId, id, tasks[0]![0]!, WRONG, minutes(0));
    for (const objective of tasks.slice(1)) {
      await answer(learnerId, id, objective[0]!, RIGHT, minutes(0));
    }

    expect(await read(learnerId, id, minutes(0))).toEqual({
      waiting: { learning: 0, dueForReview: 0, new: 0 },
      activity: "resting",
    });
  });

  test("rests an objective by its offered tasks alone, not one retired since", async () => {
    const learnerId = await newLearner();
    const { id, tasks } = await course("Retired since", [2]);
    const [retired, offered] = tasks[0]!;
    await answer(learnerId, id, retired!, WRONG, minutes(0));
    await answer(learnerId, id, offered!, WRONG, minutes(5));
    await markTasksRetired(database, [retired!], minutes(6), { byTool: false });

    // The retired one's rest is over; the one still offered rests until 15.
    expect(await read(learnerId, id, minutes(12))).toEqual({
      waiting: { learning: 0, dueForReview: 0, new: 0 },
      activity: "resting",
    });
    expect(await read(learnerId, id, minutes(15))).toEqual({
      waiting: { learning: 1, dueForReview: 0, new: 0 },
      activity: "reteach",
    });
  });
});
