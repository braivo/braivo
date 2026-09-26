// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createCourse, createObjectives, readObjectivesWithTasks } from "../persistence/index.ts";
import { chooseNextActivity } from "./activity.ts";
import type { RequestHost } from "./host.ts";
import { NotPermitted } from "./permission.ts";
import { defineTasks, InvalidTask } from "./tasks.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "tasks-test-org";
const otherOrganizationId = "tasks-test-other-org";
const author = "tasks-test-author";
const learner = "tasks-test-learner";
const now = new Date("2026-06-01T00:00:00.000Z");
const installation: RequestHost = { hostname: "localhost", installation: true };

const choice = { kind: "choice", prompt: "Which?", options: ["this", "that"], answer: 0 };

let objective!: string;
let foreignObjective!: string;
let courseId!: string;

function define(tasks: readonly { objectiveId: string; body: unknown }[], actingAs = author) {
  return defineTasks({ database, organizationId, actingAs, tasks, now });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("defining tasks", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [author],
      at: now,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at: now,
    });
    [objective] = (await createObjectives(database, organizationId, ["Ours"])) as [string];
    [foreignObjective] = (await createObjectives(database, otherOrganizationId, ["Theirs"])) as [
      string,
    ];
    courseId = await createCourse(database, {
      organizationId,
      title: "Course",
      objectiveIds: [objective],
    });
  });

  test("stores tasks a learner is then offered, without their answer", async () => {
    // Kept in order, which also shows `keepOrder` survives authoring.
    const [taskId] = await define([
      { objectiveId: objective, body: { ...choice, keepOrder: true } },
    ]);

    const next = await chooseNextActivity({
      database,
      learnerId: learner,
      courseId,
      host: installation,
      now,
    });
    expect(next).toMatchObject({
      kind: "decided",
      task: {
        id: taskId,
        kind: "choice",
        prompt: "Which?",
        options: [
          { choice: 0, text: "this" },
          { choice: 1, text: "that" },
        ],
      },
    });
    expect(next).not.toHaveProperty("task.answer");
  });

  test("offers the first task in a batch first", async () => {
    // Several, so random IDs would rarely put the first one first by chance.
    const [first] = await define(
      Array.from({ length: 8 }, (_, index) => ({
        objectiveId: objective,
        body: { ...choice, prompt: `Which, #${index}?` },
      })),
    );

    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({ task: { id: first } });
  });

  test("refuses the whole batch over one invalid task, naming it", async () => {
    const refused = await define([
      { objectiveId: objective, body: choice },
      { objectiveId: objective, body: { ...choice, answer: 5 } },
    ]).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(InvalidTask);
    expect((refused as InvalidTask).index).toBe(1);
    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toEqual({
      kind: "no-activity",
    });
  });

  test("refuses a learner, and a batch with an objective another organization owns", async () => {
    await expect(
      define([{ objectiveId: objective, body: choice }], learner),
    ).rejects.toBeInstanceOf(NotPermitted);
    await expect(
      define([
        { objectiveId: objective, body: choice },
        { objectiveId: foreignObjective, body: choice },
      ]),
    ).rejects.toBeInstanceOf(NotPermitted);
    expect(await readObjectivesWithTasks(database, [objective, foreignObjective])).toEqual(
      new Set(),
    );
  });

  test("validates tasks before checking permission", async () => {
    await expect(
      define([{ objectiveId: foreignObjective, body: { ...choice, answer: 5 } }], learner),
    ).rejects.toBeInstanceOf(InvalidTask);
  });

  test("defines nothing, and does not fail, for an empty batch", async () => {
    expect(await define([])).toEqual([]);
  });
});
