// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { course, courseObjective, member } from "@braivo/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";

import { urlLabel } from "../content/index.ts";
import { ConflictingKey } from "./key.ts";
import type { Transaction } from "./task.ts";

/**
 * `number` names it in learners' links within its organization alone, and
 * `urlLabel` follows it there, to read (`courseRef`).
 */
export type Course = { id: string; number: number; title: string; urlLabel: string };

/** A course as its organization's administrators see it: whether learners reach it yet. */
export type ManagedCourse = Course & { published: boolean };

/** What a course is listed from. */
export const COURSE_COLUMNS = {
  id: course.id,
  number: course.number,
  title: course.title,
  urlLabel: course.urlLabel,
};

/** A course as listed: its label its owner's, or else its title's. */
export function listedCourse(row: {
  id: string;
  number: number;
  title: string;
  urlLabel: string | null;
}): Course {
  const { id, number, title } = row;
  return { id, number, title, urlLabel: row.urlLabel ?? urlLabel(title) };
}

/**
 * Creates a course over objectives that already exist, in the order given.
 *
 * One transaction, because a course whose membership failed to insert is not a
 * shorter course — it is an empty one that selection would silently treat as
 * having nothing to teach. Two at once drawing the same number: the second
 * starts over, drawing another. `published` only for a new course: one found
 * under its key keeps its state.
 */
export async function createCourse(
  database: Database,
  input: {
    organizationId: string;
    title: string;
    objectiveIds: readonly string[];
    key?: string;
    published: boolean;
  },
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await insertCourse(database, input);
    } catch (error) {
      if (attempt === 3 || !isTakenNumber(error)) throw error;
    }
  }
}

/** Whether `error` is PostgreSQL refusing a course a number its organization has, as Drizzle wraps it. */
function isTakenNumber(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; constraint?: unknown } })?.cause;
  return cause?.code === "23505" && cause.constraint === "course_organization_number_uidx";
}

/**
 * A number none of the organization's courses has: four random digits while
 * any are free, then five, then one past the largest (docs/adr/0044-course-numbers.md).
 */
function freeNumber(organizationId: string): SQL<number> {
  const taken = (number: SQL) =>
    sql`select 1 from ${course} where ${course.organizationId} = ${organizationId} and ${course.number} = ${number}`;
  const random = (from: number, to: number) =>
    sql`(select n from generate_series(${from}::integer, ${to}::integer) n where not exists (${taken(sql`n`)}) order by random() limit 1)`;
  return sql<number>`coalesce(${random(1000, 9999)}, ${random(10000, 99999)}, (select max(${course.number}) + 1 from ${course} where ${course.organizationId} = ${organizationId}))`;
}

async function insertCourse(
  database: Database,
  input: Parameters<typeof createCourse>[1],
): Promise<string> {
  const id = crypto.randomUUID();

  return database.transaction(async (transaction) => {
    // Keyless courses never conflict here: nulls are distinct in the index.
    const [inserted] = await transaction
      .insert(course)
      .values({
        id,
        organizationId: input.organizationId,
        title: input.title,
        key: input.key,
        number: freeNumber(input.organizationId),
        publishedAt: input.published ? new Date() : null,
      })
      .onConflictDoNothing({ target: [course.organizationId, course.key] })
      .returning({ id: course.id });

    // The organization already has a course under this key: the same one —
    // title and objectives in the same order — is returned, as a retry needs;
    // anything else would make the key mean two courses (docs/adr/0024-idempotent-authoring.md).
    if (!inserted) {
      const [existing] = await transaction
        .select({ id: course.id, title: course.title })
        .from(course)
        .where(and(eq(course.organizationId, input.organizationId), eq(course.key, input.key!)));
      const arranged = await transaction
        .select({ objectiveId: courseObjective.objectiveId })
        .from(courseObjective)
        .where(eq(courseObjective.courseId, existing!.id))
        .orderBy(asc(courseObjective.position));
      const same =
        existing!.title === input.title &&
        arranged.length === input.objectiveIds.length &&
        arranged.every((row, position) => row.objectiveId === input.objectiveIds[position]);
      if (!same) {
        throw new ConflictingKey(
          "The course",
          input.key!,
          "a course with another title or other objectives",
        );
      }
      return existing!.id;
    }

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
 * The organization a course belongs to and whether it is published, or
 * `undefined` when there is no such course. A workflow needs it before anything
 * else of the course's, because entitlement is decided against the
 * organization rather than the course, and learners reach only what is published.
 */
export async function readCourseOrganization(
  database: Database,
  courseId: string,
): Promise<{ organizationId: string; published: boolean } | undefined> {
  const [row] = await database
    .select({ organizationId: course.organizationId, publishedAt: course.publishedAt })
    .from(course)
    .where(eq(course.id, courseId))
    .limit(1);

  return row && { organizationId: row.organizationId, published: row.publishedAt !== null };
}

/**
 * Every course an organization has, by title.
 *
 * A listing order, like the one for objectives: what a course orders is its own
 * objectives, and nothing orders the courses themselves.
 */
export async function readCourses(
  database: Database,
  organizationId: string,
): Promise<ManagedCourse[]> {
  const rows = await database
    .select({ ...COURSE_COLUMNS, publishedAt: course.publishedAt })
    .from(course)
    .where(eq(course.organizationId, organizationId))
    .orderBy(asc(course.title), asc(course.id));
  return rows.map((row) => ({ ...listedCourse(row), published: row.publishedAt !== null }));
}

/**
 * Publishes the organization's courses `courseIds` within `transaction`, all
 * or none: `false`, and nothing written, when it has not every one. One
 * published already keeps when it was, so a retry changes nothing.
 */
export async function publishCourses(
  transaction: Transaction,
  input: { organizationId: string; courseIds: readonly string[]; now: Date },
): Promise<boolean> {
  const { organizationId, courseIds, now } = input;
  if (courseIds.length === 0) return true;

  const found = await transaction
    .select({ id: course.id })
    .from(course)
    .where(and(eq(course.organizationId, organizationId), inArray(course.id, [...courseIds])))
    // In one order, so overlapping batches wait for each other, not deadlock.
    .orderBy(course.id)
    .for("update");
  if (found.length !== new Set(courseIds).size) return false;
  await transaction
    .update(course)
    .set({ publishedAt: now })
    .where(
      and(
        eq(course.organizationId, organizationId),
        inArray(course.id, [...courseIds]),
        isNull(course.publishedAt),
      ),
    );
  return true;
}

/**
 * Sets the label after a course's number in its links if it is still
 * `previous`: saved then, or when it is `urlLabel` already, so a retry
 * succeeds; else not, with the label now; `undefined` without such a course.
 */
export async function updateCourseUrlLabel(
  database: Database,
  input: { organizationId: string; courseId: string; urlLabel: string; previous: string },
): Promise<{ saved: true } | { saved: false; urlLabel: string } | undefined> {
  return database.transaction(async (transaction) => {
    const [row] = await transaction
      .select(COURSE_COLUMNS)
      .from(course)
      .where(and(eq(course.organizationId, input.organizationId), eq(course.id, input.courseId)))
      .for("update");
    if (!row) return undefined;

    const current = listedCourse(row).urlLabel;
    if (current === input.urlLabel) return { saved: true };
    if (current !== input.previous) return { saved: false, urlLabel: current };
    await transaction
      .update(course)
      .set({ urlLabel: input.urlLabel })
      .where(eq(course.id, input.courseId));
    return { saved: true };
  });
}

/**
 * Every published course of every organization this user belongs to, or of just
 * `organizationId` when given, and of those just the one numbered `number`, by
 * title. A user is a member of an organization at most once, so the join cannot
 * repeat a course; the index enforcing it is hand-written in migrations, not in
 * `schema/auth.ts`.
 */
export async function readLearnerCourses(
  database: Database,
  learnerId: string,
  only: { organizationId?: string; number?: number } = {},
): Promise<Course[]> {
  const rows = await database
    .select(COURSE_COLUMNS)
    .from(course)
    .innerJoin(member, eq(member.organizationId, course.organizationId))
    .where(
      and(
        eq(member.userId, learnerId),
        isNotNull(course.publishedAt),
        only.organizationId === undefined
          ? undefined
          : eq(course.organizationId, only.organizationId),
        only.number === undefined ? undefined : eq(course.number, only.number),
      ),
    )
    .orderBy(asc(course.title), asc(course.id));
  return rows.map(listedCourse);
}

/**
 * The published courses each of these objectives is in, by title: those a task
 * of it reaches once published. Objectives in none are left out.
 */
export async function readPublishedCoursesByObjective(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Map<string, { id: string; title: string }[]>> {
  if (objectiveIds.length === 0) return new Map();

  const rows = await database
    .select({ id: course.id, title: course.title, objectiveId: courseObjective.objectiveId })
    .from(courseObjective)
    .innerJoin(course, eq(course.id, courseObjective.courseId))
    .where(
      and(inArray(courseObjective.objectiveId, [...objectiveIds]), isNotNull(course.publishedAt)),
    )
    .orderBy(asc(course.title), asc(course.id));
  const courses = new Map<string, { id: string; title: string }[]>();
  for (const { objectiveId, ...listed } of rows) {
    const listing = courses.get(objectiveId);
    if (listing) listing.push(listed);
    else courses.set(objectiveId, [listed]);
  }
  return courses;
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
