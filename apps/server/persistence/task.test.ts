// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { attempt, task } from "@braivo/db/schema";
import {
  clearLearnerHistory,
  createTask,
  seedOrganization,
  sharedDatabase,
} from "@braivo/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createObjectives } from "./objective.ts";
import { markTasksRetired, recordAttempt, RetiredTask } from "./task.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "task-persistence-test-org";
const learner = "task-persistence-test-learner";
const at = new Date("2026-06-01T00:00:00.000Z");

let objectiveId!: string;
let taskId!: string;

/** Resolves once another session waits on a `FOR SHARE` lock. */
async function waitingOnShareLock(): Promise<void> {
  for (;;) {
    const waiting = await database.execute(
      sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%for share%'`,
    );
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function record(attemptId: string) {
  return recordAttempt(database, {
    learnerId: learner,
    attemptId,
    taskId,
    response: { choice: 0 },
    at,
    restWindowStart: at,
    evidence: { id: `attempt:${attemptId}`, objectiveId, outcome: "success" },
  });
}

/** Requires TEST_DATABASE_URL: locking is the database's to do. */
describe.skipIf(!connectionString)("recording an attempt on a retired task", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds: [learner], at });
    [objectiveId] = (await createObjectives(database, organizationId, ["Retiring"])) as [string];
  });

  beforeEach(async () => {
    await clearLearnerHistory(database, [learner]);
    taskId = await createTask(database, {
      organizationId,
      objectiveId,
      body: { kind: "choice", prompt: "?", options: ["a", "b"], answer: 0 },
      createdAt: at,
    });
  });

  test("refuses it, recording nothing", async () => {
    await markTasksRetired(database, [taskId], at);

    await expect(record("after")).rejects.toBeInstanceOf(RetiredTask);
    expect(await database.select().from(attempt).where(eq(attempt.taskId, taskId))).toEqual([]);
  });

  test("retiring again keeps the first date", async () => {
    await markTasksRetired(database, [taskId], at);
    await markTasksRetired(database, [taskId], new Date(at.getTime() + 1000));

    const [stored] = await database
      .select({ retiredAt: task.retiredAt })
      .from(task)
      .where(eq(task.id, taskId));
    expect(stored?.retiredAt).toEqual(at);
  });

  test("waits for a retirement in progress, then refuses it", async () => {
    let updated!: () => void;
    const hasUpdated = new Promise<void>((resolve) => (updated = resolve));
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    const retiring = database.transaction(async (transaction) => {
      await transaction.update(task).set({ retiredAt: at }).where(eq(task.id, taskId));
      updated();
      await mayCommit;
    });
    await hasUpdated;

    // Committed only once the attempt waits for it, or has been recorded
    // without waiting, which is the failure this pins.
    const recording = record("during");
    await Promise.race([recording.catch(() => {}), waitingOnShareLock()]);
    commit();
    await retiring;

    await expect(recording).rejects.toBeInstanceOf(RetiredTask);
  });
});
