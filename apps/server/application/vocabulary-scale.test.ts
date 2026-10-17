// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  createCourse,
  createObjectives,
  createTasks,
  recordEvidence,
} from "../persistence/index.ts";
import { chooseNextActivity } from "./activity.ts";
import type { RequestHost } from "./host.ts";
import { readLearnerProgress } from "./learner-progress.ts";

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
  readLearnerProgress({ database: db, viewedBy: learnerId, learnerId, courseId, host, now });

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

    // Measured 70 to 150 ms each (2026-10-11, local PostgreSQL): a bound an
    // order of magnitude above, for a regression in the shape, not the constant.
    test("answers within a second at 5,000 words and 50,000 results", async () => {
      expect(await median(() => activity(database, practice))).toBeLessThan(1000);
      expect(await median(() => progress(database, practice))).toBeLessThan(1000);
      // 24 calls: each within its bound, together they may pass the default 5 s.
    }, 60_000);
  },
);
