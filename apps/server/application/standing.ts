// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Where a learner stands, as progress-8 names it to them: one definition for
// the server's course list and the learn app's notices, so the two never
// disagree. Pure, so `@braivo/server/client` hands it to the browser.

/**
 * An objective's standing for a learner: the model's phases, with `due`
 * splitting retaining, so a learner is told no more than the model holds:
 * "retained", not "mastered", which Braivo does not define.
 */
export type Standing = "retained" | "dueForReview" | "learning" | "notStarted";

/** How many of a course's objectives stand where. */
export type CourseStanding = Record<Standing, number>;

/** An objective's standing, from its phase and, retaining, whether it is due. */
export function standingOf(objective: {
  phase: "unseen" | "acquiring" | "retaining";
  due?: boolean;
}): Standing {
  if (objective.phase === "unseen") return "notStarted";
  if (objective.phase === "acquiring") return "learning";
  return objective.due ? "dueForReview" : "retained";
}

/** `objectives` counted by standing, every standing present, none counted as 0. */
export function countStandings(
  objectives: readonly Parameters<typeof standingOf>[0][],
): CourseStanding {
  const counts: CourseStanding = { retained: 0, dueForReview: 0, learning: 0, notStarted: 0 };
  for (const objective of objectives) counts[standingOf(objective)]++;
  return counts;
}
