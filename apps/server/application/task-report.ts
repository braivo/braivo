// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { isStorableText } from "../content/index.ts";
import {
  insertTaskReport,
  readCourseOrganization,
  readCourseTask,
  readEvidenceOutcome,
  readReportableAttempt,
  type TaskReportReason,
} from "../persistence/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
import { hostAdmits, type RequestHost } from "./host.ts";
import { isMember } from "./permission.ts";

export type { TaskReportReason } from "../persistence/index.ts";

const REASONS: ReadonlySet<string> = new Set<TaskReportReason>([
  "answer-correct",
  "key-wrong",
  "confusing",
  "unsupported",
  "other",
]);

/** A note's limit, as a typed answer's: room to explain, not to paste a page. */
export const MAX_REPORT_NOTE_LENGTH = 500;

/** What a learner sends: a reason, and a note, trimmed, when there is one. */
export type TaskReportInput = { reason: TaskReportReason; note?: string };

/**
 * A report's body, or `undefined` when it is not one Braivo stores: an unknown
 * reason, a note that is not text, past the limit, or not storable, or
 * `other` without a note. A blank note is none. Whether `answer-correct` fits
 * the attempt is `reportAttempt`'s to judge.
 */
export function parseTaskReport(body: unknown): TaskReportInput | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { reason, note } = body as Record<string, unknown>;
  if (typeof reason !== "string" || !REASONS.has(reason)) return undefined;
  if (note !== undefined && typeof note !== "string") return undefined;

  const trimmed = note?.trim();
  if (trimmed) {
    if (!isStorableText(trimmed, MAX_REPORT_NOTE_LENGTH)) return undefined;
    return { reason: reason as TaskReportReason, note: trimmed };
  }
  if (reason === "other") return undefined;
  return { reason: reason as TaskReportReason };
}

/**
 * A learner reports a problem with a task they answered, from its feedback
 * (docs/adr/0052-task-reports.md). The attempt names the task and the answer,
 * so the report stores neither; it changes nothing about the attempt, its
 * evidence, the rest, or what is offered. Reached as `submitAttempt` reaches a
 * course, the attempt the learner's own of a task in it: anything else is
 * `unavailable`, alike. Accepted on a task retired since, since its feedback
 * was on screen.
 */
export async function reportAttempt(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  attemptId: string;
  report: TaskReportInput;
  now: Date;
}): Promise<ReportedAttempt> {
  const { database, learnerId, courseId, host, attemptId, report, now } = input;

  const course = await readCourseOrganization(database, courseId);
  if (course === undefined || !course.open) return { kind: "unavailable" };
  const { organizationId } = course;
  if (!(await hostAdmits(database, host, organizationId))) return { kind: "unavailable" };
  if (!(await isMember(database, { organizationId, userId: learnerId }))) {
    return { kind: "unavailable" };
  }

  const answered = await readReportableAttempt(database, { learnerId, organizationId, attemptId });
  if (answered === undefined) return { kind: "unavailable" };
  const task = await readCourseTask(database, { courseId, taskId: answered.taskId });
  if (task === undefined) return { kind: "unavailable" };

  // Only a miss the learner answered: never a success, nor Show answer, which
  // is a failure the learner asked for. Read from the evidence, never regraded.
  if (report.reason === "answer-correct") {
    if ("reveal" in answered.response) return { kind: "invalid" };
    const outcome = await readEvidenceOutcome(database, {
      learnerId,
      organizationId,
      evidenceId: `${ATTEMPT_EVIDENCE_PREFIX}${attemptId}:${task.objectiveId}`,
    });
    if (outcome !== "failure") return { kind: "invalid" };
  }

  const stored = await insertTaskReport(database, {
    learnerId,
    organizationId,
    attemptId,
    taskId: answered.taskId,
    reason: report.reason,
    note: report.note,
    at: now,
  });
  // Another attempt's report of the task is open, or this attempt's says otherwise.
  if (
    stored === undefined ||
    stored.stored.reason !== report.reason ||
    (stored.stored.note ?? undefined) !== report.note
  ) {
    return { kind: "already-reported" };
  }

  const { reason, note, at } = stored.stored;
  return {
    kind: "stored",
    created: stored.created,
    report: { reason, ...(note !== null && { note }), at },
  };
}

/**
 * `unavailable`: no such course for the learner, or no such attempt of theirs
 * in it. `invalid`: `answer-correct` on an attempt that was no miss.
 * `already-reported`: the attempt's report says otherwise, or the learner's
 * undismissed report of the task is another attempt's. `stored`, `created`
 * only the first time.
 */
export type ReportedAttempt =
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "already-reported" }
  | {
      kind: "stored";
      created: boolean;
      report: { reason: TaskReportReason; note?: string; at: Date };
    };
