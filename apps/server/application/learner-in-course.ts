// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, type KnowledgeEstimate, replay } from "../learning/index.ts";
import {
  readCourseObjectives,
  readCourseOrganization,
  readLearnerEvidence,
  readOrganizationRoles,
} from "../persistence/index.ts";

/**
 * What every view of a learner in a course is computed from: the course's
 * objectives in content order, and the learner's estimates at a moment, replayed
 * under `activeModel` (ADR 0007).
 *
 * `objectiveIds` is the whole course. Eligibility rules, when they arrive, narrow
 * it in the decision rather than here, since a report must still show every
 * objective.
 */
type LearnerInCourse = {
  objectiveIds: readonly string[];
  estimates: ReadonlyMap<string, KnowledgeEstimate>;
};

/**
 * Loads a learner as they stand in a course at `now`, or `undefined` when the
 * course is missing, `authorize` refuses, or the learner is not in the course's
 * organization; callers cannot tell which. "What next" and "where they stand"
 * both load through here, so they cannot drift apart.
 *
 * The organization comes from the course, never from the caller. `authorize` is
 * required, so forgetting it fails to compile; a learner reading for themselves
 * passes `() => true`. It runs before the membership query, so a refused reader
 * cannot time whether the learner is a member. Whether the course exists still
 * shows in timing, since a missing one skips `authorize`.
 */
export async function loadLearnerInCourse(
  database: Database,
  input: {
    courseId: string;
    learnerId: string;
    now: Date;
    authorize: (organizationId: string) => boolean | Promise<boolean>;
  },
): Promise<LearnerInCourse | undefined> {
  const { courseId, learnerId, now, authorize } = input;

  const organizationId = await readCourseOrganization(database, courseId);
  if (organizationId === undefined) return undefined;
  if (!(await authorize(organizationId))) return undefined;

  // Any role will do: being in the organization is what entitles a learner to
  // its material. What anyone may *do* to it is asked elsewhere.
  const roles = await readOrganizationRoles(database, { organizationId, userId: learnerId });
  if (roles.length === 0) return undefined;

  const [objectiveIds, evidence] = await Promise.all([
    readCourseObjectives(database, courseId),
    readLearnerEvidence(database, learnerId, now),
  ]);

  return { objectiveIds, estimates: replay(evidence, activeModel) };
}
