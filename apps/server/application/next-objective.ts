// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, type LearningDecision, selectNext } from "../learning/index.ts";
import { NEW_OBJECTIVES_PER_DAY, limitNewObjectives } from "./daily-limit.ts";
import type { RequestHost } from "./host.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";

/**
 * What a learner should work on next, decided from their recorded evidence.
 *
 * Estimates are replayed on every call rather than stored, so none can go stale
 * (cost: docs/adr/0007-one-learning-model.md), and from the learner's whole
 * history at the organization rather than this course's objectives
 * (docs/adr/0009-evidence-read-whole.md, docs/adr/0032-learner-history.md).
 *
 * Candidates come from the course, never the caller, so a nonexistent objective
 * cannot be asked about. Eligibility rules narrow them here, keeping their
 * vocabulary out of `learning`: so far, the daily limit on new objectives. The
 * learner must be a member of the course's organization. `now` is an argument
 * so only the process entry point reads a clock.
 */
export async function chooseNextObjective(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
  /** The learner's, an IANA name, for the day `limitNewObjectives` counts in. */
  timeZone: string;
}): Promise<NextObjective> {
  const { database, learnerId, courseId, host, now, timeZone } = input;

  // The reader is the learner, and their membership is what is checked.
  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
    now,
    // The learner themselves: only an open course.
    authorize: ({ open }) => open,
  });
  if (learner === undefined) return { kind: "unavailable" };

  const { candidates, heldBack } = limitNewObjectives(learner, { now, timeZone });
  const decision = selectNext({
    now,
    candidates,
    estimates: learner.estimates,
    model: activeModel,
  });
  if (decision !== undefined) return { kind: "decided", decision };
  return heldBack ? { kind: "daily-limit", limit: NEW_OBJECTIVES_PER_DAY } : { kind: "caught-up" };
}

/**
 * `unavailable` covers both a missing course and one this learner may not see, so
 * the answer never confirms that a course exists; timing still differs by one
 * membership query.
 *
 * `caught-up` is reached only after membership is confirmed, so it reveals
 * nothing, and it tells a client "come back later" rather than "not for you". A
 * course with no objectives yet is caught up too. `daily-limit` is caught up but
 * for objectives not started yet, held back until tomorrow (`limitNewObjectives`).
 */
export type NextObjective =
  | { kind: "unavailable" }
  | { kind: "caught-up" }
  | { kind: "daily-limit"; limit: number }
  | { kind: "decided"; decision: LearningDecision };
