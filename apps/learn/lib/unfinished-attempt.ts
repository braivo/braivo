// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Activity, LearningDecision, TaskResponse } from "@braivo/server/client";

/**
 * An answer sent and not yet continued past, kept so a reload can resend it
 * and show its feedback (learner-loop-20). With its activity: once the answer
 * is recorded, the next activity is another.
 */
export type UnfinishedAttempt = {
  id: string;
  activity: Extract<Activity, { task: unknown }>;
  response: TaskResponse;
};

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
const INTENTS: Record<LearningDecision["intent"], true> = {
  introduce: true,
  reteach: true,
  review: true,
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
    typeof attempt.response?.choice === "number" &&
    Object.hasOwn(INTENTS, decision?.intent ?? "") &&
    (decision?.intent !== "review" || typeof decision.retrievability === "number") &&
    typeof objective?.title === "string" &&
    task?.kind === "choice" &&
    typeof task.id === "string" &&
    typeof task.prompt === "string" &&
    Array.isArray(task.options) &&
    task.options.every(
      (option) => typeof option?.choice === "number" && typeof option.text === "string",
    )
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
