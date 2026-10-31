// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { hasExplanation } from "../content/explanation.ts";
import {
  createCourse,
  createObjectives,
  createSource,
  markCourseDeleted,
  readCourseTasks,
} from "../persistence/index.ts";
import { publish } from "./courses.ts";
import { NotPermitted } from "./permission.ts";
import { defineTasks, listCourseTasks, retireTasks } from "./tasks.ts";

// A course's tasks at once, as an assistant finds those without an
// explanation (authoring spec, the course-scoped task listing).

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "course-tasks-test-org";
const otherOrganizationId = "course-tasks-test-other-org";
const author = "course-tasks-test-author";
const learner = "course-tasks-test-learner";
const now = new Date("2026-06-01T00:00:00.000Z");

/** A choice task, explained unless `explanation` is false. */
const choice = (prompt: string, explanation: string | false = `Because of ${prompt}.`) => ({
  kind: "choice",
  prompt,
  options: ["yes", "no"],
  answer: 0,
  ...(explanation === false ? {} : { explanation }),
});

let first!: string;
let second!: string;
let courseId!: string;
/** When the next write happens: a second after the last, so separate writes never tie. */
let clock = now.getTime();

/** Writes tasks to `objectiveId` and answers their IDs, as the console or as a tool. */
async function write(
  objectiveId: string,
  bodies: readonly unknown[],
  {
    byTool = false,
    replaces,
    at = new Date((clock += 1000)),
  }: { byTool?: boolean; replaces?: string; at?: Date } = {},
) {
  const written = await defineTasks({
    database,
    organizationId,
    actingAs: author,
    tasks: bodies.map((body) => ({ objectiveId, body, ...(replaces && { replaces }) })),
    now: at,
    byTool,
  });
  return written.map(({ id }) => id);
}

/**
 * `database`, its queries' results held until `meanwhile` has run once the
 * `nth` query answered, in or out of a transaction: a write committed between
 * a read's queries, deterministically.
 */
function interleaved(nth: number, meanwhile: () => Promise<unknown>): typeof database {
  let queries = 0;
  const hold = <T extends object>(builder: T, at: number): T =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === "then") {
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            (target as unknown as Promise<unknown>)
              .then(async (rows) => {
                if (at === nth) await meanwhile();
                return rows;
              })
              .then(resolve, reject);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, args);
          return typeof result === "object" && result !== null ? hold(result, at) : result;
        };
      },
    });
  const counting = <T extends object>(queryable: T): T =>
    new Proxy(queryable, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === "select") {
          return (...args: unknown[]) =>
            hold((value as (...args: unknown[]) => object).apply(target, args), ++queries);
        }
        if (key === "transaction") {
          return (run: (transaction: object) => unknown, config?: unknown) =>
            (value as (...args: unknown[]) => unknown).call(
              target,
              (transaction: object) => run(counting(transaction)),
              config,
            );
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return counting(database);
}

const list = (options: { withoutExplanation?: boolean } = {}) =>
  listCourseTasks({
    database,
    organizationId,
    actingAs: author,
    courseId,
    withoutExplanation: options.withoutExplanation ?? false,
  });

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("a course's tasks", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    clock = now.getTime();
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
    // Created second first, so content order, not creation, is what orders them.
    [second, first] = (await createObjectives(database, organizationId, ["Second", "First"])) as [
      string,
      string,
    ];
    courseId = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Course",
        objectiveIds: [first, second],
      })
    ).id;
  });

  test("lists the course's objectives in content order, each's tasks oldest first", async () => {
    const later = new Date(now.getTime() + 60_000);
    const [b1] = await write(second, [choice("B1")]);
    const [a2] = await write(first, [choice("A2")], { at: later });
    const [a1] = await write(first, [choice("A1")]);
    const [b2] = await write(second, [choice("B2")], { byTool: true, at: later });

    const page = await list();
    expect(
      page!.tasks.map(({ id, objectiveId, published }) => ({ id, objectiveId, published })),
    ).toEqual([
      { id: a1, objectiveId: first, published: true },
      { id: a2, objectiveId: first, published: true },
      { id: b1, objectiveId: second, published: true },
      { id: b2, objectiveId: second, published: false },
    ]);
    expect(page!.tasks[0]).toMatchObject({ body: choice("A1"), citations: [] });
  });

  test("lists the tasks without an explanation, published or pending, with any pending correction on its original", async () => {
    const [explained, published, correctedLater, correctedNow, removed, retired] = await write(
      first,
      [
        choice("Explained"),
        // As a draft accepted with its blank explanation left out: no field at all.
        choice("Published", false),
        choice("Corrected later", false),
        choice("Corrected now", false),
        choice("Removed"),
        choice("Retired", false),
      ],
    );
    const [pending] = await write(second, [choice("Pending", false)], { byTool: true });
    await retireTasks({
      database,
      organizationId,
      actingAs: author,
      taskIds: [retired!],
      now,
      byTool: false,
    });
    // A tool's corrections wait beside their published originals: one adding an
    // explanation, one leaving it out, one dropping the original's.
    const [adding] = await write(first, [choice("Corrected later")], {
      byTool: true,
      replaces: correctedLater!,
    });
    const [notAdding] = await write(first, [choice("Corrected now!", false)], {
      byTool: true,
      replaces: correctedNow!,
    });
    const [dropping] = await write(first, [choice("Removed", false)], {
      byTool: true,
      replaces: removed!,
    });

    const page = await list({ withoutExplanation: true });
    expect(
      page!.tasks.map(({ id, published, replaces, pendingCorrection }) => ({
        id,
        published,
        ...(replaces && { replaces }),
        ...(pendingCorrection && { pendingCorrection }),
      })),
    ).toEqual([
      { id: published, published: true },
      {
        id: correctedLater,
        published: true,
        pendingCorrection: { id: adding, hasExplanation: true },
      },
      {
        id: correctedNow,
        published: true,
        pendingCorrection: { id: notAdding, hasExplanation: false },
      },
      { id: notAdding, published: false, replaces: correctedNow },
      { id: dropping, published: false, replaces: removed },
      { id: pending, published: false },
    ]);
    expect(page!.tasks.map(({ id }) => id)).not.toContain(explained);
    expect(page!.counts).toEqual({
      published: { total: 5, withoutExplanation: 3, withoutExplanationOrPassage: 3 },
      pending: { total: 4, withoutExplanation: 3 },
    });
  });

  test("counts over the whole course, filtered or not, agreeing with a full listing", async () => {
    const lesson = await createSource(database, {
      organizationId,
      title: "Lesson",
      text: "Hola means hello. Adiós means goodbye.",
      createdAt: now,
    });
    const cited = (prompt: string, quote: string) => ({
      objectiveId: first,
      body: choice(prompt, false),
      citations: [{ sourceId: lesson, quote }],
    });
    await defineTasks({
      database,
      organizationId,
      actingAs: author,
      tasks: [cited("Hola?", "Hola means hello."), cited("Adiós?", "Adiós means goodbye.")],
      now,
      byTool: false,
    });
    await write(second, [choice("Bare", false), choice("Explained")]);
    await write(second, [choice("Waiting", false), choice("Waiting, explained")], {
      byTool: true,
    });

    const { tasks: all, counts } = (await list())!;
    const published = all.filter((task) => task.published);
    const pendingTasks = all.filter((task) => !task.published);
    const expected = {
      published: {
        total: published.length,
        withoutExplanation: published.filter(({ body }) => !hasExplanation(body)).length,
        withoutExplanationOrPassage: published.filter(
          ({ body, citations }) => !hasExplanation(body) && citations.length === 0,
        ).length,
      },
      pending: {
        total: pendingTasks.length,
        withoutExplanation: pendingTasks.filter(({ body }) => !hasExplanation(body)).length,
      },
    };
    expect(expected).toEqual({
      published: { total: 4, withoutExplanation: 3, withoutExplanationOrPassage: 1 },
      pending: { total: 2, withoutExplanation: 1 },
    });
    expect(counts).toEqual(expected);
    expect((await list({ withoutExplanation: true }))!.counts).toEqual(expected);
  });

  test("answers whoever may author, and nothing for a course the organization does not have", async () => {
    await expect(
      listCourseTasks({
        database,
        organizationId,
        actingAs: learner,
        courseId,
        withoutExplanation: false,
      }),
    ).rejects.toBeInstanceOf(NotPermitted);

    const [theirs] = (await createObjectives(database, otherOrganizationId, ["Theirs"])) as [
      string,
    ];
    const theirCourse = await createCourse(database, {
      published: true,
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirs],
    });
    expect(
      await listCourseTasks({
        database,
        organizationId,
        actingAs: author,
        courseId: theirCourse.id,
        withoutExplanation: false,
      }),
    ).toBeUndefined();
  });

  test("answers nothing for a deleted course", async () => {
    const gone = await createCourse(database, {
      published: false,
      organizationId,
      title: "Gone",
      objectiveIds: [first],
    });
    await markCourseDeleted(database, { organizationId, courseId: gone.id, now });

    for (const withoutExplanation of [false, true]) {
      expect(
        await readCourseTasks(database, organizationId, gone.id, { withoutExplanation }),
      ).toBeUndefined();
    }
  });

  test("reads one state of the course while a task is retired meanwhile", async () => {
    const [pending] = await write(first, [choice("Pending", false)], { byTool: true });
    // Retired once the tasks are listed, before the rest is read.
    const reading = interleaved(2, () =>
      retireTasks({
        database,
        organizationId,
        actingAs: author,
        taskIds: [pending!],
        now,
        byTool: true,
      }),
    );

    const read = await readCourseTasks(reading, organizationId, courseId, {
      withoutExplanation: false,
    });
    // As before the retirement: never itself as its retired twin, counted as listed.
    expect(read!.tasks).toEqual([expect.objectContaining({ id: pending, published: false })]);
    expect(read!.tasks[0]).not.toHaveProperty("matchesRetiredTask");
    expect(read!.counts.pending).toEqual({ total: 1, withoutExplanation: 1 });
    expect((await list())!.tasks).toEqual([]);
  });

  test("reads one state of the course while a correction is published meanwhile", async () => {
    const [original] = await write(first, [choice("Original", false)]);
    const [correction] = await write(first, [choice("Original")], {
      byTool: true,
      replaces: original!,
    });
    const reading = interleaved(2, () =>
      publish({
        database,
        organizationId,
        actingAs: author,
        courseIds: [],
        taskIds: [correction!],
        now,
      }),
    );

    const read = await readCourseTasks(reading, organizationId, courseId, {
      withoutExplanation: true,
    });
    // As before publishing: the gap with its correction named, counted as listed.
    expect(read!.tasks).toEqual([
      expect.objectContaining({
        id: original,
        pendingCorrection: { id: correction, hasExplanation: true },
      }),
    ]);
    expect(read!.counts).toEqual({
      published: { total: 1, withoutExplanation: 1, withoutExplanationOrPassage: 1 },
      pending: { total: 1, withoutExplanation: 0 },
    });
    expect((await list({ withoutExplanation: true }))!.tasks).toEqual([]);
  });

  test("lists a published task once its correction is published, the original gone", async () => {
    const [original] = await write(first, [choice("Original", false)]);
    const [correction] = await write(first, [choice("Original")], {
      byTool: true,
      replaces: original!,
    });
    await publish({
      database,
      organizationId,
      actingAs: author,
      courseIds: [],
      taskIds: [correction!],
      now,
    });

    const page = await list({ withoutExplanation: true });
    expect(page!.tasks).toEqual([]);
    expect(page!.counts.published).toEqual({
      total: 1,
      withoutExplanation: 0,
      withoutExplanationOrPassage: 0,
    });
  });
});
