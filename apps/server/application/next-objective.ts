// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, type LearningDecision, selectNext } from "../learning/index.ts";
import type { RequestHost } from "./host.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";

/**
 * What a learner should work on next, decided from their recorded evidence.
 *
 * Estimates are replayed on every call rather than stored, so none can go stale
 * (cost: docs/adr/0007-one-learning-model.md), and from the whole history rather
 * than this course's objectives (docs/adr/0009-evidence-is-read-whole.md).
 *
 * Candidates come from the course, never the caller, so a nonexistent objective
 * cannot be asked about. Eligibility rules will narrow them here, keeping their
 * vocabulary out of `learning`. The learner must be a member of the course's
 * organization. `now` is an argument so only the process entry point reads a
 * clock.
 */
export async function chooseNextObjective(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
}): Promise<NextObjective> {
  const { database, learnerId, courseId, host, now } = input;

  // The reader is the learner, and their membership is what is checked.
  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
    now,
    authorize: () => true,
  });
  if (learner === undefined) return { kind: "unavailable" };

  const decision = selectNext({
    now,
    candidates: learner.objectiveIds,
    estimates: learner.estimates,
    model: activeModel,
  });
  return decision ? { kind: "decided", decision } : { kind: "caught-up" };
}

/**
 * `unavailable` covers both a missing course and one this learner may not see, so
 * the answer never confirms that a course exists; timing still differs by one
 * membership query.
 *
 * `caught-up` is reached only after membership is confirmed, so it reveals
 * nothing, and it tells a client "come back later" rather than "not for you". A
 * course with no objectives yet is caught up too.
 */
export type NextObjective =
  | { kind: "unavailable" }
  | { kind: "caught-up" }
  | { kind: "decided"; decision: LearningDecision };
