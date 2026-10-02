// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { task as taskTable } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  createCourse,
  createObjectives,
  createSource,
  createTasks,
  readObjectivesWithTasks,
  readTaskCitations,
} from "../persistence/index.ts";
import { StaleCorrection } from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import { InvalidCitation } from "./citations.ts";
import type { RequestHost } from "./host.ts";
import { NotPermitted } from "./permission.ts";
import { defineTasks, InvalidTask, retireTasks } from "./tasks.ts";

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

type Draft = {
  objectiveId: string;
  body: unknown;
  citations?: { sourceId: string; quote: string }[];
  replaces?: string;
};

function define(tasks: readonly Draft[], actingAs = author) {
  return defineTasks({ database, organizationId, actingAs, tasks, now });
}

/** A lesson with a character outside the BMP, so code points and UTF-16 differ. */
function addLesson(organization = organizationId) {
  return createSource(database, {
    organizationId: organization,
    title: "Unidad 1",
    text: "🙂 Hola significa hello. Adiós significa goodbye.",
    createdAt: now,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("tasks", () => {
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
    ).toMatchObject({
      kind: "no-activity",
      objective: { id: objective },
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

  test("retires a task: never offered, no new attempt accepted, and retiring twice is harmless", async () => {
    const [wrong, right] = (await define([
      { objectiveId: objective, body: choice },
      { objectiveId: objective, body: { ...choice, prompt: "Which, again?" } },
    ])) as [string, string];
    const retire = (taskIds: string[], actingAs = author) =>
      retireTasks({ database, organizationId, actingAs, taskIds, now });
    const answer = (attemptId: string) =>
      submitAttempt({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        attemptId,
        taskId: wrong,
        // Failed, so the objective stays in practice and a task is still offered.
        response: { choice: 1 },
        now,
      });

    const before = await answer("before");
    expect(before).toMatchObject({ kind: "graded", grade: { outcome: "failure" } });
    await retire([wrong]);
    await retire([wrong]);

    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({
      task: { id: right },
    });
    // A resend whose answer was lost still gets its grade; a new answer does not.
    expect(await answer("before")).toEqual(before);
    expect(await answer("after")).toEqual({ kind: "unavailable" });

    // With its last task retired, the objective has nothing left to practise.
    await retire([right]);
    expect(await readObjectivesWithTasks(database, [objective])).toEqual(new Set());
    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({
      kind: "no-activity",
      objective: { id: objective },
    });
  });

  test("refuses to retire for a learner, or a task another organization owns", async () => {
    const [ours] = (await define([{ objectiveId: objective, body: choice }])) as [string];
    // Stored directly: nobody here may author for the other organization.
    const [theirs] = (await createTasks(
      database,
      otherOrganizationId,
      [{ objectiveId: foreignObjective, body: { ...choice, kind: "choice" } }],
      now,
    )) as [string];
    const retire = (taskIds: string[], actingAs = author) =>
      retireTasks({ database, organizationId, actingAs, taskIds, now });

    await expect(retire([ours], learner)).rejects.toBeInstanceOf(NotPermitted);
    await expect(retire([ours, theirs])).rejects.toBeInstanceOf(NotPermitted);
    await expect(retire(["no-such-task"])).rejects.toBeInstanceOf(NotPermitted);
    // Refused whole: the task that was the organization's is still offered.
    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({
      task: { id: ours },
    });
  });

  test("defines nothing, and does not fail, for an empty batch", async () => {
    expect(await define([])).toEqual([]);
  });

  test("stores the passages each task was written from, located in its source", async () => {
    const lesson = await addLesson();

    const [greeting, plain] = await define([
      {
        objectiveId: objective,
        body: choice,
        citations: [
          { sourceId: lesson, quote: "Hola significa hello." },
          { sourceId: lesson, quote: "Adiós   significa goodbye." },
        ],
      },
      { objectiveId: objective, body: choice },
    ]);

    // The emoji is one position, and the reflowed quote reads back as written.
    expect(await readTaskCitations(database, greeting!)).toEqual([
      {
        sourceId: lesson,
        start: 2,
        end: 23,
        quote: "Hola significa hello.",
        source: { title: "Unidad 1" },
      },
      {
        sourceId: lesson,
        start: 24,
        end: 48,
        quote: "Adiós significa goodbye.",
        source: { title: "Unidad 1" },
      },
    ]);
    expect(await readTaskCitations(database, plain!)).toEqual([]);
  });

  test("refuses the whole batch over one quote not in its source, naming task and citation", async () => {
    const lesson = await addLesson();

    const refused = define([
      { objectiveId: objective, body: choice, citations: [{ sourceId: lesson, quote: "Hola" }] },
      {
        objectiveId: objective,
        body: choice,
        citations: [
          { sourceId: lesson, quote: "Adiós" },
          { sourceId: lesson, quote: "Buenas noches" },
        ],
      },
    ]);

    await expect(refused).rejects.toBeInstanceOf(InvalidCitation);
    await expect(refused).rejects.toThrow(
      "Task 1, citation 1: the quote does not occur in the source.",
    );
    // No task either: one stored without its citations could never be given them.
    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({
      kind: "no-activity",
      objective: { id: objective },
    });
  });

  test("stores a passage one task cites twice once", async () => {
    const lesson = await addLesson();
    const quote = { sourceId: lesson, quote: "Hola significa hello." };

    const [taskId] = await define([
      { objectiveId: objective, body: choice, citations: [quote, quote] },
    ]);

    expect(await readTaskCitations(database, taskId!)).toHaveLength(1);
  });

  test("refuses a learner before looking at their quotes", async () => {
    // Otherwise whether a quote occurs would tell them what the source says.
    const lesson = await addLesson();

    await expect(
      define(
        [{ objectiveId: objective, body: choice, citations: [{ sourceId: lesson, quote: "x" }] }],
        learner,
      ),
    ).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses a citation of another organization's source, storing nothing", async () => {
    const theirs = await addLesson(otherOrganizationId);

    await expect(
      define([
        { objectiveId: objective, body: choice, citations: [{ sourceId: theirs, quote: "Hola" }] },
      ]),
    ).rejects.toBeInstanceOf(NotPermitted);
    expect(
      await chooseNextActivity({ database, learnerId: learner, courseId, host: installation, now }),
    ).toMatchObject({
      kind: "no-activity",
      objective: { id: objective },
    });
  });

  describe("adding a task already there", () => {
    /** The objective's unretired tasks, however they were added. */
    const stored = async () =>
      (
        await database
          .select({ id: taskTable.id })
          .from(taskTable)
          .where(and(eq(taskTable.objectiveId, objective), isNull(taskTable.retiredAt)))
      ).map((row) => row.id);

    test("returns it rather than storing it twice, as a retrying agent needs", async () => {
      const lesson = await addLesson();
      const draft = {
        objectiveId: objective,
        body: choice,
        citations: [{ sourceId: lesson, quote: "Hola significa hello." }],
      };

      const [first] = await define([draft]);
      // Written another way — keys reordered, the passage quoted twice — it is the same task.
      const [again] = await define([
        {
          ...draft,
          body: { answer: 0, options: ["this", "that"], prompt: "Which?", kind: "choice" },
          citations: [...draft.citations, ...draft.citations],
        },
      ]);

      expect(again).toBe(first);
      expect(await stored()).toEqual([first]);
    });

    test("matches a retry whose values JSON stores differently, such as an answer of -0", async () => {
      const [first] = await define([{ objectiveId: objective, body: { ...choice, answer: -0 } }]);
      const [again] = await define([{ objectiveId: objective, body: { ...choice, answer: -0 } }]);

      expect(again).toBe(first);
      expect(await stored()).toEqual([first]);
    });

    test("returns one ID for a task repeated within a batch", async () => {
      const [one, two] = await define([
        { objectiveId: objective, body: choice },
        { objectiveId: objective, body: choice },
      ]);

      expect(two).toBe(one);
      expect(await stored()).toEqual([one]);
    });

    test("keeps a task with other passages, or options in another order, as its own", async () => {
      const lesson = await addLesson();

      const ids = await define([
        { objectiveId: objective, body: choice },
        { objectiveId: objective, body: choice, citations: [{ sourceId: lesson, quote: "Hola" }] },
        // The same options reordered is another question: `answer` points elsewhere.
        { objectiveId: objective, body: { ...choice, options: ["that", "this"], answer: 1 } },
      ]);

      expect(new Set(ids).size).toBe(3);
    });

    test("adds a retired task anew, since adding it again is how to bring it back", async () => {
      const [retired] = await define([{ objectiveId: objective, body: choice }]);
      await retireTasks({ database, organizationId, actingAs: author, taskIds: [retired!], now });

      const [back] = await define([{ objectiveId: objective, body: choice }]);

      expect(back).not.toBe(retired);
      expect(await stored()).toEqual([back]);
    });

    test("stores one task when writers race to add the same one", async () => {
      const ids = (
        await Promise.all(
          Array.from({ length: 4 }, () =>
            createTasks(
              database,
              organizationId,
              [{ objectiveId: objective, body: { ...choice, kind: "choice" } }],
              now,
            ),
          ),
        )
      ).flat();

      expect(new Set(ids).size).toBe(1);
      expect(await stored()).toHaveLength(1);
    });
  });
  describe("correcting a task", () => {
    /** The objective's unretired tasks, oldest first. */
    const offered = async () =>
      (
        await database
          .select({ id: taskTable.id })
          .from(taskTable)
          .where(and(eq(taskTable.objectiveId, objective), isNull(taskTable.retiredAt)))
          .orderBy(taskTable.createdAt)
      ).map((row) => row.id);
    const correct = (replaces: string, body: object, actingAs = author) =>
      define([{ objectiveId: objective, body, replaces }], actingAs);

    test("stores the correction and retires the task in one step, which a retry repeats", async () => {
      const [wrong] = (await define([{ objectiveId: objective, body: choice }])) as [string];

      const [fixed] = await correct(wrong, { ...choice, answer: 1 });
      expect(fixed).not.toBe(wrong);
      expect(await offered()).toEqual([fixed]);
      // Sent again after a lost answer: the same correction, nothing added or refused.
      expect(await correct(wrong, { ...choice, answer: 1 })).toEqual([fixed]);
      expect(await offered()).toEqual([fixed]);
    });

    test("keeps a task its correction does not change", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];

      expect(await correct(task, choice)).toEqual([task]);
      expect(await offered()).toEqual([task]);
    });

    test("refuses a correction of a task already retired, unless what it asks for is offered", async () => {
      const [task, other] = (await define([
        { objectiveId: objective, body: choice },
        { objectiveId: objective, body: { ...choice, prompt: "Which, again?" } },
      ])) as [string, string];
      await retireTasks({ database, organizationId, actingAs: author, taskIds: [task], now });

      // Written from a stale read: stored nothing.
      await expect(correct(task, { ...choice, answer: 1 })).rejects.toBeInstanceOf(StaleCorrection);
      expect(await offered()).toEqual([other]);
      // Asking for a task already offered converges on it.
      expect(await correct(task, { ...choice, prompt: "Which, again?" })).toEqual([other]);
      expect(await offered()).toEqual([other]);
    });

    test("lets one of two racing corrections of a task through, refusing the other", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];

      const results = await Promise.allSettled([
        correct(task, { ...choice, answer: 1 }),
        correct(task, { ...choice, prompt: "Which one?" }),
      ]);

      const [won] = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      const lost = results.flatMap((result) => (result.status === "rejected" ? result.reason : []));
      expect(lost).toEqual([expect.any(StaleCorrection)]);
      expect(await offered()).toEqual([won]);
    });

    test("leaves one task when two corrections cross, each into the other", async () => {
      const [a, b] = (await define([
        { objectiveId: objective, body: choice },
        { objectiveId: objective, body: { ...choice, answer: 1 } },
      ])) as [string, string];

      // Either way round, the second replaces a task still live: both succeed.
      const results = await Promise.allSettled([
        correct(a, { ...choice, answer: 1 }),
        correct(b, choice),
      ]);

      expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await offered()).toHaveLength(1);
    });

    test("corrects one task a request, in its own objective, of the organization's own", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [elsewhere] = (await createObjectives(database, organizationId, ["Elsewhere"])) as [
        string,
      ];
      const [theirs] = (await createTasks(
        database,
        otherOrganizationId,
        [{ objectiveId: foreignObjective, body: { ...choice, kind: "choice" } }],
        now,
      )) as [string];
      const lesson = await addLesson();
      const refusal = (tasks: Draft[], actingAs = author) =>
        define(tasks, actingAs).catch((error: unknown) => error);

      // Refused from the payload alone, before the role is read.
      const together = await refusal(
        [
          { objectiveId: objective, body: { ...choice, prompt: "New" } },
          { objectiveId: objective, body: { ...choice, answer: 1 }, replaces: task },
        ],
        learner,
      );
      expect(together).toBeInstanceOf(InvalidTask);
      expect((together as Error).message).toContain("Task 1 replaces a task, so it is sent alone");
      const moved = await refusal([{ objectiveId: elsewhere, body: choice, replaces: task }]);
      expect(moved).toBeInstanceOf(InvalidTask);
      expect((moved as Error).message).toContain("Task 0 replaces a task of another objective");
      for (const replaces of [theirs, "no-such-task"]) {
        // Refused before its quote, which is not in the source, is looked for.
        const foreign = await refusal([
          {
            objectiveId: objective,
            body: { ...choice, answer: 1 },
            citations: [{ sourceId: lesson, quote: "Not in the lesson." }],
            replaces,
          },
        ]);
        expect(foreign).toBeInstanceOf(NotPermitted);
      }
      expect(await offered()).toEqual([task]);
    });
  });
});
