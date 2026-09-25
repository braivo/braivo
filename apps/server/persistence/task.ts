// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isDeepStrictEqual } from "node:util";

import type { Database } from "@braivo/db";
import { attempt, courseObjective, learnerEvidence, task } from "@braivo/db/schema";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

import type { TaskBody, TaskResponse } from "../content/index.ts";
import type { Evidence } from "../learning/index.ts";

type Task = { id: string; objectiveId: string; body: TaskBody };

/**
 * An attempt ID this learner already used for a different task or response.
 * Like `ConflictingEvidence`, a client bug to surface rather than a retry to
 * absorb: the first submission's evidence already stands.
 */
export class ConflictingAttempt extends Error {
  constructor(readonly id: string) {
    super(`Attempt "${id}" is already recorded with a different task or response.`);
    this.name = "ConflictingAttempt";
  }
}

/** A new attempt on a task retired since it was read. */
export class RetiredTask extends Error {
  constructor() {
    super("The task was retired.");
    this.name = "RetiredTask";
  }
}

/** A new attempt on a task this learner answered too recently in another. */
export class RestingTask extends Error {
  constructor() {
    super("The task was answered too recently to answer again.");
    this.name = "RestingTask";
  }
}

/**
 * Stores tasks and returns their generated IDs, positionally matching the tasks
 * given. Bodies must already be valid — `content` validates them — since a
 * stored task is never corrected.
 *
 * Each is stamped a millisecond after the one before it, so tasks created
 * together are offered in the order given rather than in the order of their
 * random IDs (`readNextTask` breaks ties oldest first). A batch sent sooner
 * after a large one than its size in milliseconds may interleave with it; an
 * ordering column would fix that, once authoring needs one.
 */
export async function createTasks(
  database: Database,
  organizationId: string,
  tasks: readonly { objectiveId: string; body: TaskBody }[],
  createdAt: Date,
): Promise<string[]> {
  if (tasks.length === 0) return [];

  const rows = tasks.map(({ objectiveId, body }, index) => ({
    id: crypto.randomUUID(),
    organizationId,
    objectiveId,
    body,
    createdAt: new Date(createdAt.getTime() + index),
  }));
  await database.insert(task).values(rows);
  return rows.map((row) => row.id);
}

/** The IDs among these that are not the organization's tasks, missing ones included. */
export async function findTasksOutsideOrganization(
  database: Database,
  organizationId: string,
  taskIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(taskIds)];
  if (wanted.length === 0) return [];

  const owned = await database
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.organizationId, organizationId), inArray(task.id, wanted)));

  const inside = new Set(owned.map((row) => row.id));
  return wanted.filter((id) => !inside.has(id));
}

/**
 * Stamps tasks retired, so they are never offered or answered again. A task
 * already retired keeps its first date.
 */
export async function markTasksRetired(
  database: Database,
  taskIds: readonly string[],
  at: Date,
): Promise<void> {
  if (taskIds.length === 0) return;

  await database
    .update(task)
    .set({ retiredAt: at })
    .where(and(inArray(task.id, [...taskIds]), isNull(task.retiredAt)));
}

/** Which of these objectives have at least one task still offered, and so something to practise. */
export async function readObjectivesWithTasks(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Set<string>> {
  if (objectiveIds.length === 0) return new Set();

  const rows = await database
    .selectDistinct({ objectiveId: task.objectiveId })
    .from(task)
    .where(and(inArray(task.objectiveId, [...objectiveIds]), isNull(task.retiredAt)));
  return new Set(rows.map((row) => row.objectiveId));
}

/**
 * The objective's unretired task this learner attempted least recently,
 * never-attempted first, then oldest: rotating through an objective's tasks keeps a learner from
 * answering the one they just saw. `undefined` when the objective has none.
 *
 * `lastAttemptAt` is when this learner last answered it, if ever. It is the
 * least recent, so if it was answered too recently to offer, so was every task
 * of the objective.
 */
export async function readNextTask(
  database: Database,
  input: { learnerId: string; objectiveId: string },
): Promise<(Task & { lastAttemptAt: Date | undefined }) | undefined> {
  const lastAttemptAt = sql<Date | null>`max(${attempt.at})`.mapWith(attempt.at);
  const [row] = await database
    .select({ id: task.id, objectiveId: task.objectiveId, body: task.body, lastAttemptAt })
    .from(task)
    .leftJoin(attempt, and(eq(attempt.taskId, task.id), eq(attempt.learnerId, input.learnerId)))
    .where(and(eq(task.objectiveId, input.objectiveId), isNull(task.retiredAt)))
    .groupBy(task.id)
    .orderBy(sql`${lastAttemptAt} asc nulls first`, asc(task.createdAt), asc(task.id))
    .limit(1);
  return (
    row && { ...row, body: row.body as TaskBody, lastAttemptAt: row.lastAttemptAt ?? undefined }
  );
}

/**
 * A task, provided it assesses one of this course's objectives and is not
 * retired. Answering is authorized through the course, so a task outside it is
 * as good as missing; a retired one is withdrawn, most likely for grading
 * wrongly, so answering it would record wrong evidence.
 */
export async function readCourseTask(
  database: Database,
  input: { courseId: string; taskId: string },
): Promise<Task | undefined> {
  const [row] = await database
    .select({ id: task.id, objectiveId: task.objectiveId, body: task.body })
    .from(task)
    .innerJoin(
      courseObjective,
      and(
        eq(courseObjective.courseId, input.courseId),
        eq(courseObjective.objectiveId, task.objectiveId),
      ),
    )
    .where(and(eq(task.id, input.taskId), isNull(task.retiredAt)));
  return row && { ...row, body: row.body as TaskBody };
}

/**
 * Stores an attempt and the evidence graded from it, together or not at all.
 *
 * Resubmitting the same attempt — same ID, task, and response — stores nothing
 * and returns, so a client may retry after a lost answer; its evidence keeps the
 * first submission's date. The same ID with anything else is `ConflictingAttempt`.
 * Compared after the insert, inside the transaction, so two racing submissions
 * see whichever one won (see `recordEvidence`).
 *
 * A new attempt is `RetiredTask` when the task is retired, checked under a
 * row lock: the attempt's foreign key alone would not wait for a retirement in
 * progress, so an attempt read before one could still be recorded after it.
 *
 * A new attempt is `RestingTask` when the learner answered the same task in
 * another attempt after `restWindowStart` (docs/adr/0017-task-rest.md). Checked only
 * once the insert shows the attempt is new, so a resend is never mistaken for
 * another answer, whatever was answered since.
 */
export async function recordAttempt(
  database: Database,
  input: {
    learnerId: string;
    attemptId: string;
    taskId: string;
    response: TaskResponse;
    at: Date;
    restWindowStart: Date;
    /** Dated by the attempt. */
    evidence: Omit<Evidence, "at">;
  },
): Promise<void> {
  const { learnerId, attemptId, taskId, response, at, restWindowStart, evidence } = input;

  await database.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(attempt)
      .values({ id: attemptId, learnerId, taskId, response, at })
      .onConflictDoNothing({ target: [attempt.learnerId, attempt.id] })
      .returning({ id: attempt.id });

    if (inserted.length === 0) {
      const [stored] = await transaction
        .select({ taskId: attempt.taskId, response: attempt.response })
        .from(attempt)
        .where(and(eq(attempt.learnerId, learnerId), eq(attempt.id, attemptId)));
      if (stored?.taskId === taskId && isDeepStrictEqual(stored.response, response)) return;
      throw new ConflictingAttempt(attemptId);
    }

    // FOR SHARE conflicts with the update that retires, so one waits for the other.
    const [current] = await transaction
      .select({ retiredAt: task.retiredAt })
      .from(task)
      .where(eq(task.id, taskId))
      .for("share");
    if (current?.retiredAt) throw new RetiredTask();

    const [previous] = await transaction
      .select({ id: attempt.id })
      .from(attempt)
      .where(
        and(
          eq(attempt.learnerId, learnerId),
          eq(attempt.taskId, taskId),
          ne(attempt.id, attemptId),
          gt(attempt.at, restWindowStart),
        ),
      )
      .limit(1);
    // Thrown inside the transaction, so the attempt just inserted goes with it.
    if (previous) throw new RestingTask();

    await transaction.insert(learnerEvidence).values({ ...evidence, learnerId, at });
  });
}
