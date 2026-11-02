// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { readObjective, readReviewPassages } from "../persistence/index.ts";
import type { Passage } from "./activity.ts";
import type { RequestHost } from "./host.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";

/**
 * Drafting cites at most five passages per objective; a tool may cite more,
 * and a review shows the first five, a reading's worth.
 */
const MAX_REVIEW_PASSAGES = 5;

/**
 * What a learner reads to review an objective they answered on: its title and
 * the passages it cites that a person published, in a grade's order
 * (docs/adr/0054-review-shows-an-objectives-own-passages.md). Reached as the
 * course's activity is; it records nothing.
 *
 * `unavailable` is a course the learner may not practise, an objective outside
 * it, and one they have no evidence on yet, alike: shown before a first answer,
 * a passage could give it away (ADR 0021), and telling these apart would say
 * which objectives a course has. `empty`: nothing to show.
 */
export async function reviewObjective(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  objectiveId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
}): Promise<ObjectiveReview> {
  const { database, learnerId, courseId, objectiveId, host, now } = input;

  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
    now,
    // The learner themselves: only an open course.
    authorize: ({ open }) => open,
  });
  if (learner === undefined) return { kind: "unavailable" };
  if (!learner.objectiveIds.includes(objectiveId)) return { kind: "unavailable" };
  // Evidence at the organization up to now, from any course or grader.
  if (!learner.estimates.has(objectiveId)) return { kind: "unavailable" };

  const [objective, passages] = await Promise.all([
    readObjective(database, objectiveId),
    readReviewPassages(database, { objectiveId, limit: MAX_REVIEW_PASSAGES }),
  ]);
  // Never missing: its course references it, with deletes restricted.
  if (objective === undefined) throw new Error(`Objective ${objectiveId} is missing`);
  if (passages.length === 0) return { kind: "empty" };
  return { kind: "review", title: objective.title, passages };
}

export type ObjectiveReview =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "review"; title: string; passages: Passage[] };
