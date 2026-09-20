// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, assessKnowledge, type KnowledgeReport } from "../learning/index.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";
import { mayAdminister } from "./permission.ts";

/**
 * Where a learner stands on each objective in a course, for a content owner.
 *
 * Loaded through `loadLearnerInCourse`, like `chooseNextObjective`, so both read
 * the same evidence under the same model, and what this reports as due is what
 * selection would review.
 *
 * `viewedBy` is the reader, not the learner, so it is authorized
 * (docs/adr/0010-hono-http-layer.md): it must administer the course's
 * organization, and the learner must belong to it.
 *
 * A learner reading their own progress is out of scope for now: a `member` does
 * not administer, so they are told the course is unavailable.
 */
export async function readLearnerProgress(input: {
  database: Database;
  /** The signed-in actor asking. */
  viewedBy: string;
  learnerId: string;
  courseId: string;
  now: Date;
}): Promise<LearnerProgress> {
  const { database, viewedBy, learnerId, courseId, now } = input;

  // The reader is checked before the learner is looked at, so a refused reader
  // never causes the query that would tell a member from a stranger.
  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    now,
    authorize: (organizationId) => mayAdminister(database, { organizationId, userId: viewedBy }),
  });
  if (learner === undefined) return { kind: "unavailable" };

  return {
    kind: "assessed",
    report: assessKnowledge({
      now,
      objectiveIds: learner.objectiveIds,
      estimates: learner.estimates,
      model: activeModel,
    }),
  };
}

/**
 * `unavailable` covers four cases on purpose. A missing course and one the reader
 * does not administer look alike, so a reader cannot confirm that a course
 * exists. A learner outside the organization and an ID that belongs to nobody
 * look alike, so an administrator cannot probe whether an ID exists elsewhere.
 * Timing still differs: each check that passes costs another query.
 */
export type LearnerProgress =
  | { kind: "unavailable" }
  | { kind: "assessed"; report: KnowledgeReport };
