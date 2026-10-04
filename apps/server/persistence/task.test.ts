// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { attempt, objective, task, taskCitation } from "@braivo/db/schema";
import {
  clearLearnerHistory,
  createTask,
  seedOrganization,
  sharedDatabase,
  violatedConstraint,
} from "@braivo/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import { createObjectives } from "./objective.ts";
import { createSource } from "./source.ts";
import { createTasks, markTasksRetired, recordAttempt, replaceTask, RetiredTask } from "./task.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "task-persistence-test-org";
const learner = "task-persistence-test-learner";
const at = new Date("2026-06-01T00:00:00.000Z");

let objectiveId!: string;
let taskId!: string;

/** Resolves once another session waits on a `FOR SHARE` lock, or once stopped. */
async function waitingOnShareLock(stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    const waiting = await database.execute(
      sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%for share%'`,
    );
    if (waiting.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function record(attemptId: string) {
  return recordAttempt(database, {
    learnerId: learner,
    organizationId,
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
    let settled = false;
    const waiting = waitingOnShareLock(() => settled);
    await Promise.race([recording.catch(() => {}), waiting]);
    settled = true;
    await waiting;
    commit();
    await retiring;

    await expect(recording).rejects.toBeInstanceOf(RetiredTask);
  });
});

/** Requires TEST_DATABASE_URL: the point is what the database holds. */
describe.skipIf(!connectionString)("storing a task and an attempt", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds: [learner], at });
    await clearLearnerHistory(database, [learner]);
  });

  test("keeps the body and the response as JSON values, read back as written", async () => {
    const [objective] = (await createObjectives(database, organizationId, ["Storing"])) as [string];
    const body: TaskBody = { kind: "choice", prompt: "¿Uno?", options: ["one", "two"], answer: 0 };
    const [stored] = (await createTasks(
      database,
      organizationId,
      [{ objectiveId: objective, body }],
      at,
    )) as [string];
    await recordAttempt(database, {
      learnerId: learner,
      organizationId,
      attemptId: "stored",
      taskId: stored,
      response: { choice: 1 },
      at,
      restWindowStart: at,
      evidence: { id: "attempt:stored", objectiveId: objective, outcome: "failure" },
    });

    expect(
      await database
        .select({
          body: task.body,
          response: attempt.response,
          prompt: sql`${task.body}->>'prompt'`,
          choice: sql`${attempt.response}->>'choice'`,
        })
        .from(attempt)
        .innerJoin(task, eq(task.id, attempt.taskId))
        .where(eq(attempt.taskId, stored)),
    ).toEqual([{ body, response: { choice: 1 }, prompt: "¿Uno?", choice: "1" }]);
  });
});

/** Requires TEST_DATABASE_URL: the database refuses or serialises these. */
describe.skipIf(!connectionString)("task invariants", () => {
  const ownerId = "task-integrity-test-org";
  const otherId = "task-integrity-test-other-org";
  const body: TaskBody = { kind: "choice", prompt: "¿Hola?", options: ["hi", "bye"], answer: 0 };

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    for (const id of [ownerId, otherId]) {
      await seedOrganization(database, { organizationId: id, learnerIds: [], at });
    }
  });

  /** A new task citing a passage, and a read of its row and passages as stored. */
  async function citedTask(title: string) {
    const [objectiveId] = (await createObjectives(database, ownerId, [title])) as [string];
    const sourceId = await createSource(database, {
      organizationId: ownerId,
      title: "Saludos",
      text: "¡Hola! Adiós.",
      createdAt: at,
    });
    const [taskId] = (await createTasks(
      database,
      ownerId,
      [{ objectiveId, body, citations: [{ sourceId, start: 0, end: 6 }] }],
      at,
    )) as [string];
    const stored = () =>
      Promise.all([
        database.select().from(task).where(eq(task.id, taskId)),
        database.select().from(taskCitation).where(eq(taskCitation.taskId, taskId)),
      ]);
    return { objectiveId, sourceId, taskId, stored };
  }

  test("refuses a task assessing another organization's objective", async () => {
    // Both rows exist, so a plain foreign key would take it; matching the
    // organization is what refuses it, as for a course's objectives.
    const [theirs] = (await createObjectives(database, otherId, ["Theirs"])) as [string];

    const error = await createTasks(database, ownerId, [{ objectiveId: theirs, body }], at).catch(
      (thrown: unknown) => thrown,
    );

    expect(violatedConstraint(error)).toBe("task_objective_fk");
  });

  test("refuses to delete an objective even after its task is retired", async () => {
    const [assessed] = (await createObjectives(database, ownerId, ["Assessed"])) as [string];
    const [taskId] = (await createTasks(
      database,
      ownerId,
      [{ objectiveId: assessed, body }],
      at,
    )) as [string];
    await markTasksRetired(database, [taskId], at);

    const error = await database
      .delete(objective)
      .where(eq(objective.id, assessed))
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("task_objective_fk");
  });

  // Past attempts are graded again from the task they answered, so a changed
  // body or passage would change grades already given.
  test("retiring leaves a task as stored but for the date", async () => {
    const { taskId, stored } = await citedTask("Retired");
    const [[before], cited] = await stored();

    await markTasksRetired(database, [taskId], at);

    expect(await stored()).toEqual([[{ ...before, retiredAt: at }], cited]);
  });

  test("a correction leaves the task it replaces as stored, but retired", async () => {
    const { objectiveId, sourceId, taskId, stored } = await citedTask("Corrected");
    const [[before], cited] = await stored();
    const later = new Date(at.getTime() + 1000);

    await replaceTask(
      database,
      ownerId,
      taskId,
      {
        objectiveId,
        body: { ...body, answer: 1 },
        citations: [{ sourceId, start: 7, end: 13 }],
      },
      later,
    );

    expect(await stored()).toEqual([[{ ...before, retiredAt: later }], cited]);
  });

  test("retiring takes the objective's lock before changing a task", async () => {
    // A retirement taken around an adder's lock could retire a twin the adder
    // has just answered as live (`markTasksRetired`).
    const [locked] = (await createObjectives(database, ownerId, ["Locked"])) as [string];
    const [taskId] = (await createTasks(
      database,
      ownerId,
      [{ objectiveId: locked, body }],
      at,
    )) as [string];
    // As `lockObjectiveTasks` names it.
    const key = sql`hashtextextended(${`braivo:task:${locked}`}, 0)`;
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    let release!: () => void;
    const mayRelease = new Promise<void>((resolve) => (release = resolve));
    const holder = database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${key})`);
      held();
      await mayRelease;
    });
    await isHeld;

    let done = false;
    const retiring = markTasksRetired(database, [taskId], at);
    retiring.then(
      () => (done = true),
      () => (done = true),
    );
    try {
      // Until it waits on this lock, or has finished without waiting, which is
      // the failure this pins.
      while (!done) {
        const waiting = await database.execute(
          sql`select 1 from pg_locks where locktype = 'advisory' and not granted
              and ((classid::bigint << 32) | objid::bigint) = ${key}`,
        );
        if (waiting.rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(done).toBe(false);
      // An update made before the lock would hold the row, and an adder could
      // still answer the task as live meanwhile.
      await database.transaction((transaction) =>
        transaction.execute(sql`select 1 from task where id = ${taskId} for update nowait`),
      );
    } finally {
      release();
      await holder;
      await retiring;
    }
  });
});
