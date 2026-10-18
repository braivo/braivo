// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { task as taskTable } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  createCourse,
  createObjectives,
  createSource,
  createTasks,
  readObjectivesWithTasks,
  readTaskCitations,
} from "../persistence/index.ts";
import { DuplicateCorrection, PublishedTask, StaleCorrection } from "../persistence/index.ts";
import type { Transaction } from "../persistence/task.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import { InvalidCitation } from "./citations.ts";
import { publish, StalePublication } from "./courses.ts";
import type { RequestHost } from "./host.ts";
import { NotPermitted } from "./permission.ts";
import { defineTasks, InvalidTask, listObjectiveTasks, retireTasks } from "./tasks.ts";

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

/** As a person in the console, unless `byTool`, as through a token (ADR 0039). */
/** The IDs `defineTasks` answers, in order. */
async function define(tasks: readonly Draft[], actingAs = author, { byTool = false } = {}) {
  const written = await defineTasks({ database, organizationId, actingAs, tasks, now, byTool });
  return written.map(({ id }) => id);
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

/**
 * Whether a session came to wait on `holder`'s locks before `racing` settled:
 * observing the race, rather than sleeping until it has probably begun.
 * `holder` is a transaction, which keeps its connection.
 */
async function blocks(holder: Transaction, racing: Promise<unknown>): Promise<boolean> {
  const [{ pid }] = (await holder.execute(sql`select pg_backend_pid() as pid`)).rows as [
    { pid: number },
  ];
  let settled = false;
  void racing.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    // Through `holder`, which waits on nothing, so the check needs no other connection.
    const waiting = await holder.execute(
      sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
    );
    if (waiting.rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
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
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Course",
        objectiveIds: [objective],
      })
    ).id;
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
      timeZone: "UTC",
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      retireTasks({ database, organizationId, actingAs, taskIds, now, byTool: false });
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
    ).toMatchObject({
      kind: "no-activity",
      objective: { id: objective },
    });
  });

  test("refuses to retire for a learner, or a task another organization owns", async () => {
    const [ours] = (await define([{ objectiveId: objective, body: choice }])) as [string];
    // Stored directly: nobody here may author for the other organization.
    const [theirs] = (
      await createTasks(
        database,
        otherOrganizationId,
        [{ objectiveId: foreignObjective, body: { ...choice, kind: "choice" } }],
        now,
        { published: true },
      )
    ).map(({ id }) => id) as [string];
    const retire = (taskIds: string[], actingAs = author) =>
      retireTasks({ database, organizationId, actingAs, taskIds, now, byTool: false });

    await expect(retire([ours], learner)).rejects.toBeInstanceOf(NotPermitted);
    await expect(retire([ours, theirs])).rejects.toBeInstanceOf(NotPermitted);
    await expect(retire(["no-such-task"])).rejects.toBeInstanceOf(NotPermitted);
    // Refused whole: the task that was the organization's is still offered.
    expect(
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      }),
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
      await retireTasks({
        database,
        organizationId,
        actingAs: author,
        taskIds: [retired!],
        now,
        byTool: false,
      });

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
              { published: true },
            ),
          ),
        )
      )
        .flat()
        .map(({ id }) => id);

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
      await retireTasks({
        database,
        organizationId,
        actingAs: author,
        taskIds: [task],
        now,
        byTool: false,
      });

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

    test("refuses a correction equal to another task the objective has, as a duplicate", async () => {
      const [a, b] = (await define([
        { objectiveId: objective, body: choice },
        { objectiveId: objective, body: { ...choice, answer: 1 } },
      ])) as [string, string];

      // Answered by the other task, it would retire one and take the other's
      // state, published or waiting, rather than its own (ADR 0039).
      await expect(correct(a, { ...choice, answer: 1 })).rejects.toBeInstanceOf(
        DuplicateCorrection,
      );
      await expect(correct(b, choice)).rejects.toBeInstanceOf(DuplicateCorrection);
      expect(await offered()).toEqual([a, b]);
    });

    test("corrects one task a request, in its own objective, of the organization's own", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [elsewhere] = (await createObjectives(database, organizationId, ["Elsewhere"])) as [
        string,
      ];
      const [theirs] = (
        await createTasks(
          database,
          otherOrganizationId,
          [{ objectiveId: foreignObjective, body: { ...choice, kind: "choice" } }],
          now,
          { published: true },
        )
      ).map(({ id }) => id) as [string];
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

  describe("publication", () => {
    const asTool = { byTool: true };
    /** Each task's state, in the order given. */
    const states = async (taskIds: readonly string[]) => {
      const rows = await database
        .select({
          id: taskTable.id,
          publishedAt: taskTable.publishedAt,
          retiredAt: taskTable.retiredAt,
        })
        .from(taskTable)
        .where(inArray(taskTable.id, [...taskIds]));
      return taskIds.map((id) => {
        const row = rows.find((candidate) => candidate.id === id)!;
        return { published: row.publishedAt !== null, retired: row.retiredAt !== null };
      });
    };
    const waiting = { published: false, retired: false };
    const live = { published: true, retired: false };

    test("leaves a twin as it is: only Publish publishes", async () => {
      const [proposed] = (await define(
        [{ objectiveId: objective, body: choice }],
        author,
        asTool,
      )) as [string];
      const [offered] = (await define([
        { objectiveId: objective, body: { ...choice, answer: 1 } },
      ])) as [string];

      // The console's same task answers the waiting one, still waiting; a tool's, the published one.
      expect(await define([{ objectiveId: objective, body: choice }])).toEqual([proposed]);
      expect(
        await define([{ objectiveId: objective, body: { ...choice, answer: 1 } }], author, asTool),
      ).toEqual([offered]);
      expect(await states([proposed, offered])).toEqual([waiting, live]);
    });

    /** The task a learner of the course is offered next. */
    const nextTask = async () => {
      const next = await chooseNextActivity({
        database,
        learnerId: learner,
        courseId,
        host: installation,
        now,
        timeZone: "UTC",
      });
      return next.kind === "decided" ? next.task.id : undefined;
    };
    const correctAsTool = (replaces: string, body: object) =>
      define([{ objectiveId: objective, body, replaces }], author, asTool);
    const retire = (taskIds: string[], byTool = false) =>
      retireTasks({ database, organizationId, actingAs: author, taskIds, now, byTool });
    const publishTasks = (taskIds: string[]) =>
      publish({ database, organizationId, actingAs: author, courseIds: [], taskIds, now });

    test("holds a tool's correction of a published task, which stays offered until Publish retires it", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];

      const [correction] = (await correctAsTool(task, { ...choice, answer: 1 })) as [string];
      expect(await states([task, correction])).toEqual([live, waiting]);
      expect(await nextTask()).toBe(task);
      // Read back naming the task it corrects; created in the same instant, in either order.
      const listed = await listObjectiveTasks({
        database,
        organizationId,
        actingAs: author,
        objectiveId: objective,
      });
      expect(Object.fromEntries(listed!.map(({ id, replaces }) => [id, replaces]))).toEqual({
        [task]: undefined,
        [correction]: task,
      });

      // Sent again, or unchanged: answered as stored, nothing added.
      expect(await correctAsTool(task, { ...choice, answer: 1 })).toEqual([correction]);
      expect(await correctAsTool(task, choice)).toEqual([task]);
      // One waits at a time: a second is refused, naming the one to correct instead.
      await expect(correctAsTool(task, { ...choice, prompt: "Which one?" })).rejects.toMatchObject({
        name: "CorrectionWaiting",
        waitingId: correction,
      });
      // Correcting the waiting one replaces it at once, for the same task.
      const [revised] = (await correctAsTool(correction, {
        ...choice,
        prompt: "Which one?",
      })) as [string];
      expect(await states([task, correction, revised])).toEqual([
        live,
        { published: false, retired: true },
        waiting,
      ]);

      await publishTasks([revised]);
      expect(await states([task, revised])).toEqual([{ published: true, retired: true }, live]);
      expect(await nextTask()).toBe(revised);
      // A retry after it was published answers it, changing nothing.
      expect(await correctAsTool(task, { ...choice, prompt: "Which one?" })).toEqual([revised]);
    });

    test("retires a waiting correction with its task, corrected or retired in the console", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [proposed] = (await correctAsTool(task, { ...choice, answer: 1 })) as [string];

      const [fixed] = (await define([
        { objectiveId: objective, body: { ...choice, prompt: "Which, fixed?" }, replaces: task },
      ])) as [string];
      expect(await states([task, proposed, fixed])).toEqual([
        { published: true, retired: true },
        { published: false, retired: true },
        live,
      ]);

      const [again] = (await correctAsTool(fixed, { ...choice, answer: 1 })) as [string];
      await retire([fixed]);
      expect(await states([fixed, again])).toEqual([
        { published: true, retired: true },
        { published: false, retired: true },
      ]);
    });

    test("lets a tool withdraw its waiting correction, the task still offered", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [proposed] = (await correctAsTool(task, { ...choice, answer: 1 })) as [string];

      await retire([proposed], true);
      expect(await states([task, proposed])).toEqual([live, { published: false, retired: true }]);
      // Withdrawn, so another may wait in its place.
      const [another] = (await correctAsTool(task, { ...choice, prompt: "Which one?" })) as [
        string,
      ];
      expect(await states([another])).toEqual([waiting]);
    });

    test("refuses a Publish naming a correction retired since, publishing nothing", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [proposed] = (await correctAsTool(task, { ...choice, answer: 1 })) as [string];
      const [added] = (await define(
        [{ objectiveId: objective, body: { ...choice, prompt: "Which else?" } }],
        author,
        asTool,
      )) as [string];
      await retire([task]);

      await expect(publishTasks([added, proposed])).rejects.toBeInstanceOf(StalePublication);
      expect(await states([task, proposed, added])).toEqual([
        { published: true, retired: true },
        { published: false, retired: true },
        waiting,
      ]);
    });

    test("brings a re-imported original back only as waiting, after the console changed it", async () => {
      for (const change of ["correct", "retire"] as const) {
        const body = { ...choice, prompt: `Imported, then ${change}d?` };
        const [task] = (await define([{ objectiveId: objective, body }], author, asTool)) as [
          string,
        ];
        await publishTasks([task]);
        if (change === "correct") {
          await define([{ objectiveId: objective, body: { ...body, answer: 1 }, replaces: task }]);
        } else {
          await retire([task]);
        }

        // Its retired twin does not count (ADR 0024): a new task, never live.
        const [again] = (await define([{ objectiveId: objective, body }], author, asTool)) as [
          string,
        ];
        expect(again).not.toBe(task);
        expect(await states([again])).toEqual([waiting]);
      }
    });

    test("marks a waiting task the same as one retired, in the console or by a correction", async () => {
      const lesson = await addLesson();
      const cites = (...quotes: string[]) => quotes.map((quote) => ({ sourceId: lesson, quote }));
      const asked = (prompt: string) => ({ ...choice, prompt });
      const [retired, corrected, superseded, kept] = (await define(
        [
          { objectiveId: objective, body: asked("Retired?"), citations: cites("Hola", "Adiós") },
          { objectiveId: objective, body: asked("Corrected?") },
          { objectiveId: objective, body: asked("Superseded?") },
          { objectiveId: objective, body: asked("Kept?") },
        ],
        author,
        asTool,
      )) as [string, string, string, string];
      await publishTasks([retired, corrected, superseded, kept]);
      // Retired in the console; corrected there; corrected by a tool, then published.
      await retire([retired]);
      await define([{ objectiveId: objective, body: asked("Fixed?"), replaces: corrected }]);
      const [correction] = (await correctAsTool(superseded, asked("Replaced?"))) as [string];
      await publishTasks([correction]);
      // Retired under another objective: not this one's.
      const [elsewhere] = (await createObjectives(database, organizationId, ["Elsewhere"])) as [
        string,
      ];
      const [theirs] = (await define(
        [{ objectiveId: elsewhere, body: asked("Elsewhere?") }],
        author,
        asTool,
      )) as [string];
      await retire([theirs]);

      const sentAgain = await define(
        [
          // Its passages listed the other way round: the same set.
          { objectiveId: objective, body: asked("Retired?"), citations: cites("Adiós", "Hola") },
          { objectiveId: objective, body: asked("Corrected?") },
          { objectiveId: objective, body: asked("Superseded?") },
          // Not the same as any retired: another passage, another answer, new.
          { objectiveId: objective, body: asked("Retired?"), citations: cites("Hola") },
          { objectiveId: objective, body: { ...asked("Corrected?"), answer: 1 } },
          { objectiveId: objective, body: asked("New?") },
          { objectiveId: objective, body: asked("Elsewhere?") },
        ],
        author,
        asTool,
      );

      const listed = await listObjectiveTasks({
        database,
        organizationId,
        actingAs: author,
        objectiveId: objective,
      });
      const marked = (id: string) => listed!.find((each) => each.id === id)!.matchesRetiredTask;
      expect(sentAgain.map(marked)).toEqual([
        true,
        true,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      // Its quotes read as before, retired tasks' citations now read with them.
      expect(listed!.find(({ id }) => id === sentAgain[0])!.citations).toEqual([
        { sourceId: lesson, start: 2, end: 6, quote: "Hola" },
        { sourceId: lesson, start: 24, end: 29, quote: "Adiós" },
      ]);
      // Published ones are not marked, nor are the retired ones listed.
      expect(
        listed!
          .filter(({ published }) => published)
          .map(({ matchesRetiredTask }) => matchesRetiredTask),
      ).toEqual([undefined, undefined, undefined]);
      expect(listed!.map(({ id }) => id)).not.toContain(retired);
      // Published, it is no longer marked: nothing left to review.
      await publishTasks([sentAgain[0]!]);
      const after = await listObjectiveTasks({
        database,
        organizationId,
        actingAs: author,
        objectiveId: objective,
      });
      expect(after!.find(({ id }) => id === sentAgain[0])!.matchesRetiredTask).toBeUndefined();
    });

    test("settles a tool's correction racing Publish either way, never both changing one task", async () => {
      // A waiting task, then a published one's waiting correction: the two the race changes.
      const [proposed] = (await define(
        [{ objectiveId: objective, body: { ...choice, prompt: "Racing, waiting?" } }],
        author,
        asTool,
      )) as [string];
      const [task] = (await define([
        { objectiveId: objective, body: { ...choice, prompt: "Racing, published?" } },
      ])) as [string];
      const [pending] = (await correctAsTool(task, {
        ...choice,
        prompt: "Racing, published?",
        answer: 1,
      })) as [string];

      // Either may win, and each order has a sequential test: this proves the
      // race settles one way or the other, never an error or both.
      for (const raced of [proposed, pending]) {
        const [published, corrected] = await Promise.allSettled([
          publishTasks([raced]),
          correctAsTool(raced, { ...choice, prompt: `Revised ${raced}?` }),
        ]);
        expect(corrected.status).toBe("fulfilled");
        const [revision] = (corrected as PromiseFulfilledResult<string[]>).value as [string];
        if (published.status === "fulfilled") {
          // Published first: the correction waits beside it.
          expect(await states([raced, revision])).toEqual([live, waiting]);
          if (raced === pending)
            expect(await states([task])).toEqual([{ published: true, retired: true }]);
        } else {
          // Corrected first: replaced at once, so Publish found it retired.
          expect(published.reason).toBeInstanceOf(StalePublication);
          expect(await states([raced, revision])).toEqual([
            { published: false, retired: true },
            waiting,
          ]);
          if (raced === pending) expect(await states([task])).toEqual([live]);
        }
      }
    });

    test("refuses a Publish of a correction whose task is retired, however that came about", async () => {
      // Never written by Braivo, which retires a task's waiting correction with it.
      const corrected = crypto.randomUUID();
      const correction = crypto.randomUUID();
      await database.insert(taskTable).values([
        {
          id: corrected,
          organizationId,
          objectiveId: objective,
          body: choice,
          createdAt: now,
          publishedAt: now,
          retiredAt: now,
        },
        {
          id: correction,
          organizationId,
          objectiveId: objective,
          body: { ...choice, answer: 1 },
          createdAt: now,
          replacesTaskId: corrected,
        },
      ]);

      await expect(publishTasks([correction])).rejects.toBeInstanceOf(StalePublication);
      expect(await states([correction])).toEqual([waiting]);
    });

    test("refuses a tool's retirement of a task once published, even retired since, changing nothing", async () => {
      const [retired] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [proposed] = (await define(
        [{ objectiveId: objective, body: { ...choice, answer: 1 } }],
        author,
        asTool,
      )) as [string];
      await retire([retired]);

      await expect(retire([retired, proposed], true)).rejects.toMatchObject({
        name: "PublishedTask",
        // Not sent to the console, which no longer lists a retired task.
        message: `Task "${retired}" was published and is retired already; leave it out.`,
      });
      // A correction of it is stale, as anyone's is once a task is retired.
      await expect(
        correctAsTool(retired, { ...choice, prompt: "Which now?" }),
      ).rejects.toBeInstanceOf(StaleCorrection);
      expect(await states([retired, proposed])).toEqual([
        { published: true, retired: true },
        waiting,
      ]);
    });

    test("never lets a tool's retirement through once Publish took the task", async () => {
      const [task] = (await define(
        [{ objectiveId: objective, body: { ...choice, prompt: "Racing to retire?" } }],
        author,
        asTool,
      )) as [string];

      const [published, retired] = await Promise.allSettled([
        publishTasks([task]),
        retire([task], true),
      ]);

      // Whichever came first, the other is refused.
      const [state] = await states([task]);
      if (published.status === "fulfilled") {
        expect(retired).toMatchObject({ status: "rejected", reason: expect.any(PublishedTask) });
        expect(state).toEqual(live);
      } else {
        expect(published.reason).toBeInstanceOf(StalePublication);
        expect(retired.status).toBe("fulfilled");
        expect(state).toEqual({ published: false, retired: true });
      }
    });

    test("retires a corrected task only under its objective's lock, as a twin is added under", async () => {
      const [task] = (await define([{ objectiveId: objective, body: choice }])) as [string];
      const [proposed] = (await correctAsTool(task, { ...choice, answer: 1 })) as [string];

      let publishing!: Promise<void>;
      // As an import holds it while it looks for twins: one found must stay unretired.
      await database.transaction(async (adding) => {
        await adding.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`braivo:task:${objective}`}, 0))`,
        );
        publishing = publishTasks([proposed]);
        expect(await blocks(adding, publishing)).toBe(true);
        expect(await states([task])).toEqual([live]);
      });
      await publishing;
      expect(await states([task, proposed])).toEqual([{ published: true, retired: true }, live]);
    });

    test("locks the task a waiting correction corrects first, as Publish does, never deadlocking", async () => {
      // Sorting first, as Publish then locks it before the correction.
      const corrected = `lock-a-${crypto.randomUUID()}`;
      const correction = `lock-b-${crypto.randomUUID()}`;
      await database.insert(taskTable).values([
        {
          id: corrected,
          organizationId,
          objectiveId: objective,
          body: choice,
          createdAt: now,
          publishedAt: now,
        },
        {
          id: correction,
          organizationId,
          objectiveId: objective,
          body: { ...choice, answer: 1 },
          createdAt: now,
          replacesTaskId: corrected,
        },
      ]);
      const lock = (transaction: Transaction, id: string) =>
        transaction
          .select({ id: taskTable.id })
          .from(taskTable)
          .where(eq(taskTable.id, id))
          .for("update");

      let revising!: Promise<string[]>;
      await database.transaction(async (publishing) => {
        await lock(publishing, corrected);
        revising = correctAsTool(correction, { ...choice, prompt: "Which, revised?" });
        // Waiting on `corrected`. Holding the correction's row instead, its new
        // row's key would wait on `corrected`, and this on it: a deadlock.
        expect(await blocks(publishing, revising)).toBe(true);
        await lock(publishing, correction);
      });
      const [revised] = (await revising) as [string];
      expect(await states([corrected, correction, revised])).toEqual([
        live,
        { published: false, retired: true },
        waiting,
      ]);
    });
  });
});
