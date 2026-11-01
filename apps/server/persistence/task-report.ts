// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { attempt, courseObjective, learnerEvidence, task, taskReport } from "@braivo/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, lte, max, sql } from "drizzle-orm";

import type { TaskResponse } from "../content/index.ts";

/** One learner's attempt at one organization, as `taskReport` keys it. */
export type AttemptKey = { learnerId: string; organizationId: string; attemptId: string };

export type TaskReportReason = (typeof taskReport.$inferSelect)["reason"];

/** A report as stored, what the learner sent and when it first arrived. */
export type StoredTaskReport = { reason: TaskReportReason; note: string | null; at: Date };

/** The learner's own attempt: its task, response, and the outcome its evidence holds. */
export async function readReportableAttempt(
  database: Database,
  key: AttemptKey,
): Promise<{ taskId: string; response: TaskResponse } | undefined> {
  const [row] = await database
    .select({ taskId: attempt.taskId, response: attempt.response })
    .from(attempt)
    .where(
      and(
        eq(attempt.learnerId, key.learnerId),
        eq(attempt.organizationId, key.organizationId),
        eq(attempt.id, key.attemptId),
      ),
    );
  return row && { taskId: row.taskId, response: row.response as TaskResponse };
}

/** The outcome recorded under an evidence ID, as an attempt's grade wrote it. */
export async function readEvidenceOutcome(
  database: Database,
  input: { learnerId: string; organizationId: string; evidenceId: string },
): Promise<"success" | "failure" | undefined> {
  const [row] = await database
    .select({ outcome: learnerEvidence.outcome })
    .from(learnerEvidence)
    .where(
      and(
        eq(learnerEvidence.learnerId, input.learnerId),
        eq(learnerEvidence.organizationId, input.organizationId),
        eq(learnerEvidence.id, input.evidenceId),
      ),
    );
  return row?.outcome;
}

/**
 * Stores a report unless one conflicts: the attempt's own, or an undismissed
 * one of the task by the learner, whose unique index refuses racing writers
 * too. Answers the attempt's report as stored, and whether it was this one, or
 * `undefined` when the conflict was another attempt's. `taskId` must be the
 * attempt's own, read from it, never the request's: no key checks they match.
 */
export async function insertTaskReport(
  database: Database,
  input: AttemptKey & { taskId: string; reason: TaskReportReason; note?: string; at: Date },
): Promise<{ stored: StoredTaskReport; created: boolean } | undefined> {
  const { learnerId, organizationId, attemptId, taskId, reason, note, at } = input;
  const inserted = await database
    .insert(taskReport)
    .values({
      learnerId,
      organizationId,
      attemptId,
      id: crypto.randomUUID(),
      taskId,
      reason,
      note: note ?? null,
      createdAt: at,
    })
    // Untargeted, so the index on undismissed reports refuses quietly too.
    .onConflictDoNothing()
    .returning({ reason: taskReport.reason, note: taskReport.note, at: taskReport.createdAt });
  if (inserted[0]) return { stored: inserted[0], created: true };

  const [stored] = await database
    .select({ reason: taskReport.reason, note: taskReport.note, at: taskReport.createdAt })
    .from(taskReport)
    .where(
      and(
        eq(taskReport.learnerId, learnerId),
        eq(taskReport.organizationId, organizationId),
        eq(taskReport.attemptId, attemptId),
      ),
    );
  return stored && { stored, created: false };
}

/** Which open reports a reviewer reads: the organization's, or one objective's, course's, or task's. */
export type ReportScope =
  | { objectiveId: string }
  | { courseId: string }
  | { taskId: string }
  | Record<string, never>;

/** An open report as its reviewer reads it: never naming the learner. */
export type OpenTaskReport = {
  id: string;
  reason: TaskReportReason;
  note: string | null;
  at: Date;
  response: TaskResponse;
};

/** A task with open reports, its newest `reportsPerTask` of them, newest first. */
export type ReportedTaskRow = {
  taskId: string;
  objectiveId: string;
  body: unknown;
  reportCount: number;
  /** The unpublished, unretired correction a tool wrote for it, if any (ADR 0039). */
  pendingCorrectionId: string | undefined;
  reports: OpenTaskReport[];
};

/**
 * The organization's open reports, those undismissed of an unretired task,
 * grouped by task, the most recently reported task first: at most `taskLimit`
 * tasks (and whether there were more), each with its newest `reportsPerTask`.
 */
export async function readOpenTaskReports(
  database: Database,
  input: {
    organizationId: string;
    scope: ReportScope;
    taskLimit: number;
    reportsPerTask: number;
  },
): Promise<{ tasks: ReportedTaskRow[]; more: boolean }> {
  const { organizationId, scope, taskLimit, reportsPerTask } = input;
  const open = and(
    eq(taskReport.organizationId, organizationId),
    isNull(taskReport.dismissedAt),
    isNull(task.retiredAt),
    "taskId" in scope ? eq(taskReport.taskId, scope.taskId) : undefined,
    "objectiveId" in scope ? eq(task.objectiveId, scope.objectiveId) : undefined,
    "courseId" in scope
      ? inArray(
          task.objectiveId,
          database
            .select({ id: courseObjective.objectiveId })
            .from(courseObjective)
            .where(
              and(
                eq(courseObjective.courseId, scope.courseId),
                eq(courseObjective.organizationId, organizationId),
              ),
            ),
        )
      : undefined,
  );

  const grouped = await database
    .select({
      taskId: task.id,
      objectiveId: task.objectiveId,
      body: task.body,
      reportCount: count(),
    })
    .from(taskReport)
    .innerJoin(task, eq(task.id, taskReport.taskId))
    .where(open)
    // By the task's key, which determines its other columns.
    .groupBy(task.id)
    .orderBy(desc(max(taskReport.createdAt)), asc(task.id))
    .limit(taskLimit + 1);
  const shown = grouped.slice(0, taskLimit);
  if (shown.length === 0) return { tasks: [], more: false };
  const taskIds = shown.map(({ taskId }) => taskId);

  const ranked = database
    .select({
      id: taskReport.id,
      taskId: taskReport.taskId,
      reason: taskReport.reason,
      note: taskReport.note,
      at: taskReport.createdAt,
      response: attempt.response,
      rank: sql<number>`row_number() over (partition by ${taskReport.taskId} order by ${taskReport.createdAt} desc, ${taskReport.id})`.as(
        "rank",
      ),
    })
    .from(taskReport)
    .innerJoin(
      attempt,
      and(
        eq(attempt.learnerId, taskReport.learnerId),
        eq(attempt.organizationId, taskReport.organizationId),
        eq(attempt.id, taskReport.attemptId),
      ),
    )
    .where(
      and(
        eq(taskReport.organizationId, organizationId),
        isNull(taskReport.dismissedAt),
        inArray(taskReport.taskId, taskIds),
      ),
    )
    .as("ranked");
  const reports = await database
    .select()
    .from(ranked)
    .where(lte(ranked.rank, reportsPerTask))
    .orderBy(desc(ranked.at), asc(ranked.id));

  // As `readPendingCorrections` reads one: an edited correction retires the old, keeping its link.
  const corrections = await database
    .select({ id: task.id, replaces: task.replacesTaskId })
    .from(task)
    .where(
      and(inArray(task.replacesTaskId, taskIds), isNull(task.publishedAt), isNull(task.retiredAt)),
    );

  return {
    more: grouped.length > taskLimit,
    tasks: shown.map((row) => ({
      ...row,
      pendingCorrectionId: corrections.find(({ replaces }) => replaces === row.taskId)?.id,
      reports: reports
        .filter(({ taskId }) => taskId === row.taskId)
        .map(({ id, reason, note, at, response }) => ({
          id,
          reason,
          note,
          at,
          response: response as TaskResponse,
        })),
    })),
  };
}

/** How many of these report IDs are the organization's, whatever their state. */
export async function countOrganizationReports(
  database: Database,
  input: { organizationId: string; reportIds: readonly string[] },
): Promise<number> {
  const [row] = await database
    .select({ count: count() })
    .from(taskReport)
    .where(
      and(
        eq(taskReport.organizationId, input.organizationId),
        inArray(taskReport.id, [...input.reportIds]),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Dismisses exactly these reports, those still undismissed: one dismissed
 * already keeps who did it first and when, so a retry changes nothing.
 */
export async function markReportsDismissed(
  database: Database,
  input: { organizationId: string; reportIds: readonly string[]; by: string; at: Date },
): Promise<void> {
  await database
    .update(taskReport)
    .set({ dismissedAt: input.at, dismissedBy: input.by })
    .where(
      and(
        eq(taskReport.organizationId, input.organizationId),
        inArray(taskReport.id, [...input.reportIds]),
        isNull(taskReport.dismissedAt),
      ),
    );
}
