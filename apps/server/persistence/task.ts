// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isDeepStrictEqual } from "node:util";

import type { Database } from "@braivo/db";
import { attempt, courseObjective, learnerEvidence, task } from "@braivo/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { TaskBody, TaskResponse } from "../content/index.ts";
import type { Evidence } from "../learning/index.ts";

export type Task = { id: string; objectiveId: string; body: TaskBody };

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

/** Which of these objectives have at least one task, and so something to practise. */
export async function readObjectivesWithTasks(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Set<string>> {
  if (objectiveIds.length === 0) return new Set();

  const rows = await database
    .selectDistinct({ objectiveId: task.objectiveId })
    .from(task)
    .where(inArray(task.objectiveId, [...objectiveIds]));
  return new Set(rows.map((row) => row.objectiveId));
}

/**
 * The objective's task this learner attempted least recently, never-attempted
 * first, then oldest: rotating through an objective's tasks keeps a learner from
 * answering the one they just saw. `undefined` when the objective has none.
 */
export async function readNextTask(
  database: Database,
  input: { learnerId: string; objectiveId: string },
): Promise<Task | undefined> {
  const [row] = await database
    .select({ id: task.id, objectiveId: task.objectiveId, body: task.body })
    .from(task)
    .leftJoin(attempt, and(eq(attempt.taskId, task.id), eq(attempt.learnerId, input.learnerId)))
    .where(eq(task.objectiveId, input.objectiveId))
    .groupBy(task.id)
    .orderBy(sql`max(${attempt.at}) asc nulls first`, asc(task.createdAt), asc(task.id))
    .limit(1);
  return row && { ...row, body: row.body as TaskBody };
}

/**
 * A task, provided it assesses one of this course's objectives. Answering is
 * authorized through the course, so a task outside it is as good as missing.
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
    .where(eq(task.id, input.taskId));
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
 */
export async function recordAttempt(
  database: Database,
  input: {
    learnerId: string;
    attemptId: string;
    taskId: string;
    response: TaskResponse;
    at: Date;
    /** Dated by the attempt. */
    evidence: Omit<Evidence, "at">;
  },
): Promise<void> {
  const { learnerId, attemptId, taskId, response, at, evidence } = input;

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

    await transaction.insert(learnerEvidence).values({ ...evidence, learnerId, at });
  });
}
