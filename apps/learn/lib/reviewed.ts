// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * That this tab showed a learner an objective's passages since their last
 * attempt on it, for the next attempt's `reviewedTeaching` (ADR 0054). Per
 * learner, so another signing in on the tab never sends it; per objective
 * alone, whose ID is global, so the next attempt on it counts in any course.
 * Unavailable storage just means it is not said.
 */
const key = (learnerId: string, objectiveId: string) =>
  `braivo.reviewed:${learnerId}:${objectiveId}`;

export function markReviewed(learnerId: string, objectiveId: string) {
  try {
    sessionStorage.setItem(key(learnerId, objectiveId), "1");
  } catch {
    // Unavailable storage: not said (above).
  }
}

/** Whether it was marked, clearing the mark: one attempt says it. */
export function takeReviewed(learnerId: string, objectiveId: string): boolean {
  try {
    const marked = sessionStorage.getItem(key(learnerId, objectiveId)) !== null;
    sessionStorage.removeItem(key(learnerId, objectiveId));
    return marked;
  } catch {
    return false;
  }
}
