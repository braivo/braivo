// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type Course,
  createCourse,
  findObjectivesOutsideOrganization,
  readCourses,
  readLearnerCourses,
} from "../persistence/index.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/**
 * Creates a course over the organization's own objectives, in the order given;
 * that order is the candidate list selection works from.
 *
 * Ownership is checked here although composite foreign keys enforce it too, so a
 * foreign objective is a named refusal rather than a constraint violation. A
 * deletion racing the check still ends in that violation, and the schema still
 * refuses the row.
 */
export async function defineCourse(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  title: string;
  objectiveIds: readonly string[];
}): Promise<string> {
  const { database, organizationId, actingAs, title, objectiveIds } = input;

  // A course orders each objective once; a repeat would reach the database as a
  // constraint violation. Checked first, since it depends only on what was sent.
  if (new Set(objectiveIds).size !== objectiveIds.length) {
    throw new RangeError("A course lists each objective at most once.");
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const outside = await findObjectivesOutsideOrganization(database, organizationId, objectiveIds);
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  return createCourse(database, { organizationId, title, objectiveIds });
}

/** Every course an organization has, for whoever administers it. */
export async function listCourses(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<Course[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readCourses(database, organizationId);
}

/**
 * The courses a learner may study: every course of every organization they
 * belong to. Membership stands in for enrollment; this is the one place to
 * change once enrollment is defined.
 */
export async function listLearnerCourses(input: {
  database: Database;
  learnerId: string;
}): Promise<Course[]> {
  return readLearnerCourses(input.database, input.learnerId);
}
