// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { attempt, task } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import {
  createCourse,
  createObjectives,
  createTasks,
  readCourseObjectives,
  recordEvidence,
} from "../persistence/index.ts";
import { chooseNextActivity } from "./activity.ts";
import { listLearnerCoursesWithStanding } from "./courses.ts";
import type { RequestHost } from "./host.ts";
import { readLearnerProgress } from "./learner-progress.ts";
import { readRestingObjectives } from "./rest.ts";

/**
 * A vocabulary course has an objective per word, hundreds to thousands, where
 * every other suite's course has a handful. What breaks at that size without
 * failing at a handful is a query per objective or per result, so the guard
 * counts statements rather than timing them: a count is deterministic, and
 * the same on a busy machine.
 *
 * Timing is measured on request only (`BRAIVO_BENCH=1 bun run test` and this
 * file), before a course of that size reaches learners: on a shared database
 * a timed assertion fails on load as often as on a regression.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const statements: string[] = [];
const recording = testing.recordingDatabase(connectionString ?? "", statements);

const organizationId = "vocabulary-scale-test-org";
const host: RequestHost = { hostname: "localhost", installation: true };
const start = new Date("2025-01-01T00:00:00.000Z");
const now = new Date("2026-06-01T00:00:00.000Z");

/** A course and the learner practising it. */
type Practice = { learnerId: string; courseId: string };

/** A learner of its own per course: a read replays the learner's whole history (ADR 0009). */
const learnerOf = (words: number) => `vocabulary-scale-test-learner-${words}`;

/** A course of `words` objectives, each with a task, practised over `records` results. */
async function vocabularyCourse(words: number, records: number): Promise<Practice> {
  const learnerId = learnerOf(words);
  const objectiveIds = await createObjectives(
    database,
    organizationId,
    Array.from({ length: words }, (_unused, index) => `word ${index}`),
  );
  const { id: courseId } = await createCourse(database, {
    published: true,
    organizationId,
    title: `${words} words`,
    objectiveIds,
  });
  // In batches: one statement's parameters are capped at 65,535.
  for (let index = 0; index < words; index += 1000) {
    await createTasks(
      database,
      organizationId,
      objectiveIds.slice(index, index + 1000).map((objectiveId) => ({
        objectiveId,
        body: { kind: "choice", prompt: "?", options: ["a", "b"], answer: 0 },
      })),
      start,
      { published: true },
    );
  }
  // Every word started and revisited every `words` results, one result in five
  // missed, shifting each round so that every word has some of each.
  const evidence = Array.from({ length: records }, (_unused, index) => ({
    id: `${courseId}:${index}`,
    objectiveId: objectiveIds[index % words]!,
    outcome:
      (index + Math.floor(index / words)) % 5 === 0 ? ("failure" as const) : ("success" as const),
    at: new Date(start.getTime() + index * 5 * 60_000),
  }));
  for (let index = 0; index < records; index += 1000) {
    await recordEvidence(
      database,
      { learnerId, organizationId },
      evidence.slice(index, index + 1000),
    );
  }
  return { learnerId, courseId };
}

const activity = (db: typeof database, { learnerId, courseId }: Practice) =>
  chooseNextActivity({ database: db, learnerId, courseId, host, now, timeZone: "UTC" });
const progress = (db: typeof database, { learnerId, courseId }: Practice) =>
  readLearnerProgress({
    database: db,
    viewedBy: learnerId,
    accessKind: "browser",
    learnerId,
    courseId,
    host,
    now,
  });

/** Requires TEST_DATABASE_URL: what it counts is what PostgreSQL receives. */
describe.skipIf(!connectionString)("a vocabulary-sized course", () => {
  let small!: Practice;
  let large!: Practice;

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learnerOf(5), learnerOf(500)],
      at: start,
    });
    small = await vocabularyCourse(5, 50);
    large = await vocabularyCourse(500, 5000);
  });

  afterAll(async () => {
    await recording.$client.end();
  });

  /** Each course read once, neither warmed: the large one in as many statements, and some. */
  async function expectSameCount(read: typeof activity | typeof progress) {
    const counts: number[] = [];
    for (const practice of [small, large]) {
      statements.length = 0;
      await read(recording, practice);
      counts.push(statements.length);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  }

  test("chooses an activity in as many statements as a course of five", async () => {
    await expectSameCount(activity);
    // A task offered, so the path counted is the whole one.
    expect((await activity(database, large)).kind).toBe("decided");
  });

  test("reports progress in as many statements as a course of five", async () => {
    await expectSameCount(progress);
  });

  // A learner's day is worked out per evidence record: per course, that would
  // block the process for as many times the history.
  test("lists courses doing its history work once, however many share it", async () => {
    const listOrganizationId = "vocabulary-scale-test-list-org";
    const listLearnerId = "vocabulary-scale-test-list-learner";
    await testing.seedOrganization(database, {
      organizationId: listOrganizationId,
      learnerIds: [listLearnerId],
      at: start,
    });
    const objectiveIds = await createObjectives(database, listOrganizationId, ["a", "b", "c"]);
    await recordEvidence(
      database,
      { learnerId: listLearnerId, organizationId: listOrganizationId },
      objectiveIds.map((objectiveId, index) => ({
        id: `list-${index}`,
        objectiveId,
        outcome: "success" as const,
        at: start,
      })),
    );
    const addCourse = (title: string) =>
      createCourse(database, {
        published: true,
        organizationId: listOrganizationId,
        title,
        objectiveIds,
      });

    const dated = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const measure = async () => {
      dated.mockClear();
      statements.length = 0;
      const courses = await listLearnerCoursesWithStanding({
        database: recording,
        learnerId: listLearnerId,
        host,
        now,
        timeZone: "UTC",
      });
      return { courses: courses.length, dates: dated.mock.calls.length, sql: statements.length };
    };

    await addCourse("One");
    const one = await measure();
    await addCourse("Two");
    await addCourse("Three");
    const three = await measure();
    // Before asserting, so a failed one leaves later tests the real method.
    dated.mockRestore();

    expect(one.courses).toBe(1);
    expect(three.courses).toBe(3);
    expect(one.dates).toBeGreaterThan(0);
    expect(three.dates).toBe(one.dates);
    expect(three.sql).toBe(one.sql);
  });
});

describe.skipIf(!connectionString || process.env.BRAIVO_BENCH !== "1")(
  "a vocabulary-sized course, timed",
  () => {
    let practice!: Practice;

    beforeAll(async () => {
      await runMigrations(connectionString ?? "");
      await testing.seedOrganization(database, {
        organizationId,
        learnerIds: [learnerOf(5000)],
        at: start,
      });
      practice = await vocabularyCourse(5000, 50_000);
    }, 120_000);

    /** The median of twelve calls, so that no single slow one decides. */
    async function median(call: () => Promise<unknown>): Promise<number> {
      const runs: number[] = [];
      for (let index = 0; index < 12; index++) {
        const began = performance.now();
        await call();
        runs.push(performance.now() - began);
      }
      return runs.toSorted((a, b) => a - b)[6]!;
    }

    // A learner's attempts as many as their results, a few inside the rest
    // window, the worst case for what waits: the second read runs too. Measured
    // 5 to 10 ms for what rests, 3 to 5 with nothing recent, 70 to 115 for the
    // whole list (2026-11-06, local PostgreSQL): bounds well above, as below.
    test("reads what rests, and lists what waits, at 50,000 attempts", async () => {
      const objectiveIds = await readCourseObjectives(database, practice.courseId);
      const tasks = await database
        .select({ id: task.id })
        .from(task)
        .where(inArray(task.objectiveId, objectiveIds));
      for (let index = 0; index < 50_000; index += 1000) {
        await database.insert(attempt).values(
          Array.from({ length: 1000 }, (_unused, offset) => ({
            id: `${practice.courseId}:${index + offset}`,
            learnerId: practice.learnerId,
            organizationId,
            taskId: tasks[(index + offset) % tasks.length]!.id,
            response: { choice: 0 },
            // The last few within ten minutes of `now`, the rest long before.
            at:
              index + offset >= 49_990
                ? new Date(now.getTime() - (50_000 - index - offset) * 1000)
                : new Date(start.getTime() + (index + offset) * 5 * 60_000),
          })),
        );
      }
      const rests = await median(() =>
        readRestingObjectives(database, {
          learnerId: practice.learnerId,
          organizationIds: [organizationId],
          now,
        }),
      );
      const quiet = await median(() =>
        readRestingObjectives(database, {
          learnerId: practice.learnerId,
          organizationIds: [organizationId],
          now: new Date(now.getTime() + 3_600_000),
        }),
      );
      const list = await median(() =>
        listLearnerCoursesWithStanding({
          database,
          learnerId: practice.learnerId,
          host,
          now,
          timeZone: "UTC",
        }),
      );
      expect(rests).toBeLessThan(1000);
      expect(quiet).toBeLessThan(1000);
      expect(list).toBeLessThan(3000);
    }, 120_000);

    // Measured 70 to 150 ms each (2026-10-11, local PostgreSQL): a bound an
    // order of magnitude above, for a regression in the shape, not the constant.
    test("answers within a second at 5,000 words and 50,000 results", async () => {
      expect(await median(() => activity(database, practice))).toBeLessThan(1000);
      expect(await median(() => progress(database, practice))).toBeLessThan(1000);
      // 24 calls: each within its bound, together they may pass the default 5 s.
    }, 60_000);
  },
);
