// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Activity, ActivityDecision, TaskResponse } from "@braivo/server/client";

/**
 * An answer sent and not yet continued past, kept so a reload can resend it
 * and show its feedback (learner-loop-20). With its activity: once the answer
 * is recorded, the next activity is another.
 */
export type UnfinishedAttempt = {
  id: string;
  activity: Extract<Activity, { task: unknown }>;
  response: TaskResponse;
  /** Taken when it was first sent, so every resend says the same (ADR 0054). */
  reviewedTeaching?: true;
};

/** Whether `value` is a response this app sends: exactly one of the three. */
function isResponse(value: unknown): value is TaskResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (Object.keys(response).length !== 1) return false;
  return (
    typeof response.choice === "number" ||
    typeof response.text === "string" ||
    response.reveal === true
  );
}

/**
 * Per tab, so another tab's answer is never resent here; by learner, so an
 * answer is never resent as someone else's after signing out and back in.
 * Unavailable storage, or an entry it cannot read, just means no resume.
 */
const key = (learnerId: string, courseId: string) =>
  `braivo.unfinishedAttempt:${learnerId}:${courseId}`;

export function unfinishedAttempt(
  learnerId: string,
  courseId: string,
): UnfinishedAttempt | undefined {
  try {
    const saved = sessionStorage.getItem(key(learnerId, courseId));
    const attempt: unknown = saved ? JSON.parse(saved) : undefined;
    return isUnfinishedAttempt(attempt) ? attempt : undefined;
  } catch {
    return undefined;
  }
}

/** Typed as a record, so a new intent cannot be left out unnoticed. */
const INTENTS: Record<ActivityDecision["intent"], true> = {
  introduce: true,
  reteach: true,
  review: true,
  practise: true,
};

/**
 * What the course page reads to resend and show it, checked since an entry may
 * come from another release of the app: one it cannot show would fail the page.
 */
function isUnfinishedAttempt(value: unknown): value is UnfinishedAttempt {
  const attempt = value as UnfinishedAttempt | undefined;
  const { decision, objective, task } = attempt?.activity ?? {};
  return (
    typeof attempt?.id === "string" &&
    isResponse(attempt.response) &&
    typeof attempt.activity?.historyEpoch === "number" &&
    (attempt.reviewedTeaching === undefined || attempt.reviewedTeaching === true) &&
    Object.hasOwn(INTENTS, decision?.intent ?? "") &&
    (decision?.intent !== "review" || typeof decision.retrievability === "number") &&
    typeof objective?.title === "string" &&
    typeof task?.id === "string" &&
    typeof task.prompt === "string" &&
    (task.kind === "typed" ||
      (task.kind === "choice" &&
        Array.isArray(task.options) &&
        task.options.every(
          (option) => typeof option?.choice === "number" && typeof option.text === "string",
        )))
  );
}

export function saveUnfinishedAttempt(
  learnerId: string,
  courseId: string,
  attempt: UnfinishedAttempt,
) {
  try {
    sessionStorage.setItem(key(learnerId, courseId), JSON.stringify(attempt));
  } catch {
    // See above.
  }
}

export function clearUnfinishedAttempt(learnerId: string, courseId: string) {
  try {
    sessionStorage.removeItem(key(learnerId, courseId));
  } catch {
    // See above.
  }
}

/**
 * A notice owed after an answer was refused for good: `refused`, a reload's
 * resend (400, 403, 404, 409, 413) or a live answer's 404 or 409, which the
 * reload alone would show as if it counted; `history-erased`, any answer's, its history gone (learner-loop-25). Kept apart from the attempt,
 * already deleted, so it outlives a next-activity read that fails and is tried
 * again; cleared once shown (learner-loop-20).
 */
export type RefusalNotice = "refused" | "history-erased";

const refusalNoticeKey = (learnerId: string, courseId: string) =>
  `braivo.refusalNotice:${learnerId}:${courseId}`;

export function markRefusalNotice(learnerId: string, courseId: string, notice: RefusalNotice) {
  try {
    sessionStorage.setItem(refusalNoticeKey(learnerId, courseId), notice);
  } catch {
    // See above: unsaid, rather than failing the page.
  }
}

export function readRefusalNotice(learnerId: string, courseId: string): RefusalNotice | undefined {
  try {
    const notice = sessionStorage.getItem(refusalNoticeKey(learnerId, courseId));
    if (notice === null) return undefined;
    return notice === "history-erased" ? notice : "refused";
  } catch {
    return undefined;
  }
}

export function clearRefusalNotice(learnerId: string, courseId: string) {
  try {
    sessionStorage.removeItem(refusalNoticeKey(learnerId, courseId));
  } catch {
    // See above.
  }
}
