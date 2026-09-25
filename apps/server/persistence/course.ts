// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { course, courseObjective, member } from "@braivo/db/schema";
import { asc, eq } from "drizzle-orm";

export type Course = { id: string; title: string };

/**
 * Creates a course over objectives that already exist, in the order given.
 *
 * One transaction, because a course whose membership failed to insert is not a
 * shorter course — it is an empty one that selection would silently treat as
 * having nothing to teach.
 */
export async function createCourse(
  database: Database,
  input: { organizationId: string; title: string; objectiveIds: readonly string[] },
): Promise<string> {
  const id = crypto.randomUUID();

  return database.transaction(async (transaction) => {
    await transaction
      .insert(course)
      .values({ id, organizationId: input.organizationId, title: input.title });

    if (input.objectiveIds.length > 0) {
      await transaction.insert(courseObjective).values(
        input.objectiveIds.map((objectiveId, position) => ({
          organizationId: input.organizationId,
          courseId: id,
          objectiveId,
          position,
        })),
      );
    }

    return id;
  });
}

/**
 * The organization a course belongs to, or `undefined` when there is no such
 * course. A workflow needs it before anything else of the course's, because
 * entitlement is decided against the organization rather than the course.
 */
export async function readCourseOrganization(
  database: Database,
  courseId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ organizationId: course.organizationId })
    .from(course)
    .where(eq(course.id, courseId))
    .limit(1);

  return row?.organizationId;
}

/**
 * Every course an organization has, by title.
 *
 * A listing order, like the one for objectives: what a course orders is its own
 * objectives, and nothing orders the courses themselves.
 */
export async function readCourses(database: Database, organizationId: string): Promise<Course[]> {
  return database
    .select({ id: course.id, title: course.title })
    .from(course)
    .where(eq(course.organizationId, organizationId))
    .orderBy(asc(course.title), asc(course.id));
}

/**
 * Every course of every organization this user belongs to, by title. A user is
 * a member of an organization at most once, so the join cannot repeat a course;
 * the index enforcing it is hand-written in migrations, not in `schema/auth.ts`.
 */
export async function readLearnerCourses(database: Database, learnerId: string): Promise<Course[]> {
  return database
    .select({ id: course.id, title: course.title })
    .from(course)
    .innerJoin(member, eq(member.organizationId, course.organizationId))
    .where(eq(member.userId, learnerId))
    .orderBy(asc(course.title), asc(course.id));
}

/**
 * A course's objectives in content order, ready to hand to `learning` as its
 * candidate list.
 *
 * The stored `position` stops here: what leaves is a plain array whose order is
 * the content order, which is the form the learning model requires — candidates
 * carry no order field, so no two can claim the same place once they have left
 * this function, and the primary key keeps any objective from appearing twice.
 */
export async function readCourseObjectives(
  database: Database,
  courseId: string,
): Promise<string[]> {
  const rows = await database
    .select({ objectiveId: courseObjective.objectiveId })
    .from(courseObjective)
    .where(eq(courseObjective.courseId, courseId))
    .orderBy(asc(courseObjective.position));

  return rows.map((row) => row.objectiveId);
}
