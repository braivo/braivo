// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import type { RequestHost } from "./host.ts";

/**
 * Objectives whose last task is retired between `chooseNextActivity` reading
 * which objectives have one and reading the task itself: a race, staged here.
 */
const retiredMeanwhile = new Set<string>();
vi.mock("../persistence/index.ts", async (importOriginal) => {
  const persistence = await importOriginal<typeof import("../persistence/index.ts")>();
  return {
    ...persistence,
    readNextTask: async (...args: Parameters<typeof persistence.readNextTask>) =>
      retiredMeanwhile.has(args[1].objectiveId) ? undefined : persistence.readNextTask(...args),
  };
});

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "activity-retired-task-test-org";
const learnerId = "activity-retired-task-test-learner";
const host: RequestHost = { hostname: "localhost", installation: true };
const now = new Date("2026-06-01T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const question: TaskBody = { kind: "choice", prompt: "?", options: ["right", "wrong"], answer: 0 };

/** A published course of `titles`, in that order, those named in `withTasks` with a task. */
async function course(titles: string[], withTasks: string[]) {
  const objectiveIds = await createObjectives(database, organizationId, titles);
  const tasks = new Map<string, string>();
  for (const [index, title] of titles.entries()) {
    if (!withTasks.includes(title)) continue;
    const objectiveId = objectiveIds[index]!;
    tasks.set(
      title,
      await testing.createTask(database, {
        organizationId,
        objectiveId,
        body: question,
        createdAt: minutesAgo(10_000),
      }),
    );
  }
  const { id } = await createCourse(database, {
    published: true,
    organizationId,
    title: titles.join(", "),
    objectiveIds,
  });
  return { id, objectiveIds, tasks };
}

const activity = (courseId: string, timeZone = "UTC") =>
  chooseNextActivity({ database, learnerId, courseId, host, now, timeZone });

function answer(courseId: string, taskId: string, choice: number, at: Date) {
  return submitAttempt({
    database,
    learnerId,
    courseId,
    host,
    attemptId: crypto.randomUUID(),
    taskId,
    response: { choice },
    now: at,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the activity when a task is retired meanwhile", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, { organizationId, learnerIds: [learnerId], at: now });
  });

  beforeEach(async () => {
    retiredMeanwhile.clear();
    await testing.clearLearnerHistory(database, [learnerId]);
  });

  test("decides again without an objective whose last task was retired meanwhile", async () => {
    const { id, objectiveIds } = await course(["Retired", "Untaught"], ["Retired"]);
    retiredMeanwhile.add(objectiveIds[0]!);

    // As if it never had one: first in course order among those without.
    expect(await activity(id)).toMatchObject({
      kind: "no-activity",
      objective: { id: objectiveIds[0], title: "Retired" },
    });
  });

  test("waits for a rest rather than an objective whose last task was retired meanwhile", async () => {
    const { id, objectiveIds, tasks } = await course(
      ["Resting", "Retired"],
      ["Resting", "Retired"],
    );
    await answer(id, tasks.get("Resting")!, 1, minutesAgo(2));
    retiredMeanwhile.add(objectiveIds[1]!);

    expect(await activity(id)).toEqual({
      kind: "resting",
      objective: { id: objectiveIds[0], title: "Resting" },
      retryAt: minutesAgo(-8),
    });
  });
});
