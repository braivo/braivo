// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { attempt, learnerEvidence, taskReport } from "@braivo/db/schema";
import { and, eq } from "drizzle-orm";

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
