// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Database } from "@braivo/db";
import { course, group, groupCourse, groupMember, user } from "@braivo/db/schema";
import { aliasedTable, and, asc, eq, exists, inArray, sql } from "drizzle-orm";

import { type Course, COURSE_COLUMNS, listedCourse } from "./course.ts";
import { ConflictingKey } from "./key.ts";

/** Who is in a group and which courses it takes: what creating one sets, whole. */
export type GroupDefinition = {
  name: string;
  learnerIds: readonly string[];
  teacherIds: readonly string[];
  courseIds: readonly string[];
};

/**
 * What changing a group sets: a new name, people and courses removed, then
 * people added in a role and courses added. What it leaves out stays as it is.
 */
export type GroupChange = {
  name?: string;
  add?: {
    learnerIds?: readonly string[];
    teacherIds?: readonly string[];
    courseIds?: readonly string[];
  };
  remove?: { userIds?: readonly string[]; courseIds?: readonly string[] };
};

/** A person as a group lists them: no email, as `Member`. */
export type GroupPerson = { userId: string; name: string };

/** A group as read: its people by name and its courses by title. */
export type Group = {
  id: string;
  organizationId: string;
  name: string;
  learners: GroupPerson[];
  teachers: GroupPerson[];
  courses: Course[];
};

/**
 * Creates a group, or returns the one created under `key` with the same
 * definition (docs/adr/0024-idempotent-authoring.md); one created otherwise is
 * `ConflictingKey`.
 */
export async function createGroup(
  database: Database,
  input: { organizationId: string; key?: string; definition: GroupDefinition },
): Promise<string> {
  const { organizationId, key, definition } = input;
  const id = crypto.randomUUID();
  const creationDigest = definitionDigest(definition);

  return database.transaction(async (transaction) => {
    // Keyless groups never conflict here: nulls are distinct in the index.
    const [inserted] = await transaction
      .insert(group)
      .values({ id, organizationId, name: definition.name, key, creationDigest })
      .onConflictDoNothing({ target: [group.organizationId, group.key] })
      .returning({ id: group.id });

    // Created by a request racing this one, after the caller's lookup.
    if (!inserted)
      return (await findCreatedGroup(transaction, { organizationId, key: key!, definition }))!;

    await addPeople(transaction, organizationId, id, definition);
    await addCourses(transaction, organizationId, id, definition.courseIds);
    return id;
  });
}

/**
 * The group the organization created under `key`, when it was created with
 * `definition`, else `ConflictingKey`; `undefined` when there is none. A
 * retry is answered from here before its people and courses are checked
 * against the organization as it is now: someone in it may have left since.
 */
export async function findCreatedGroup(
  database: Database | Transaction,
  input: { organizationId: string; key: string; definition: GroupDefinition },
): Promise<string | undefined> {
  const { organizationId, key, definition } = input;
  const [existing] = await database
    .select({ id: group.id, creationDigest: group.creationDigest })
    .from(group)
    .where(and(eq(group.organizationId, organizationId), eq(group.key, key)));
  if (existing && existing.creationDigest !== definitionDigest(definition)) {
    throw new ConflictingKey("The group", key, "a group created otherwise");
  }
  return existing?.id;
}

/**
 * Applies a change to a group, answering whether the organization has it. One
 * transaction, holding the group's row, so changes to one group apply one
 * after another, each whole. Removals apply first, so removing and adding
 * someone in one change sets their role; otherwise adding them in the other
 * role is `ConflictingGroupRole`. Adding what is there, or removing what is
 * not, does nothing.
 */
export async function updateGroup(
  database: Database,
  input: { organizationId: string; groupId: string; change: GroupChange },
): Promise<boolean> {
  const { organizationId, groupId, change } = input;
  const { add = {}, remove = {} } = change;

  return database.transaction(async (transaction) => {
    const [found] = await transaction
      .update(group)
      .set({ name: change.name ?? sql`${group.name}` })
      .where(and(eq(group.organizationId, organizationId), eq(group.id, groupId)))
      .returning({ id: group.id });
    if (!found) return false;

    if (remove.userIds?.length) {
      await transaction
        .delete(groupMember)
        .where(and(eq(groupMember.groupId, groupId), inArray(groupMember.userId, remove.userIds)));
    }
    if (remove.courseIds?.length) {
      await transaction
        .delete(groupCourse)
        .where(
          and(eq(groupCourse.groupId, groupId), inArray(groupCourse.courseId, remove.courseIds)),
        );
    }
    await addPeople(transaction, organizationId, groupId, {
      learnerIds: add.learnerIds ?? [],
      teacherIds: add.teacherIds ?? [],
    });
    await addCourses(transaction, organizationId, groupId, add.courseIds ?? []);
    return true;
  });
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Adding someone already in the group in the other role: a learner listed
 * among teachers by mistake would otherwise read their classmates' progress.
 */
export class ConflictingGroupRole extends Error {
  constructor(userId: string, role: string) {
    super(
      `"${userId}" is already a ${role} in the group; to change their role, remove and add them in one change.`,
    );
    this.name = "ConflictingGroupRole";
  }
}

/**
 * Puts each person in the group in their role: someone already there in it is
 * left as they are, and someone in the other is `ConflictingGroupRole`, so a
 * role changes only when the change says so.
 */
async function addPeople(
  transaction: Transaction,
  organizationId: string,
  groupId: string,
  people: Pick<GroupDefinition, "learnerIds" | "teacherIds">,
): Promise<void> {
  const rows = [
    ...people.learnerIds.map((userId) => ({ userId, role: "learner" as const })),
    ...people.teacherIds.map((userId) => ({ userId, role: "teacher" as const })),
  ];
  if (rows.length === 0) return;
  const inserted = await transaction
    .insert(groupMember)
    .values(rows.map((row) => ({ organizationId, groupId, ...row })))
    .onConflictDoNothing()
    .returning({ userId: groupMember.userId });

  const insertedIds = new Set(inserted.map(({ userId }) => userId));
  const requestedRole = new Map(rows.map(({ userId, role }) => [userId, role]));
  const alreadyIn = rows
    .filter(({ userId }) => !insertedIds.has(userId))
    .map(({ userId }) => userId);
  if (alreadyIn.length === 0) return;
  // The group's row is held, so nobody changes these roles meanwhile.
  const existing = await transaction
    .select({ userId: groupMember.userId, role: groupMember.role })
    .from(groupMember)
    .where(and(eq(groupMember.groupId, groupId), inArray(groupMember.userId, alreadyIn)));
  const conflicting = existing.find(({ userId, role }) => requestedRole.get(userId) !== role);
  if (conflicting) throw new ConflictingGroupRole(conflicting.userId, conflicting.role);
}

async function addCourses(
  transaction: Transaction,
  organizationId: string,
  groupId: string,
  courseIds: readonly string[],
): Promise<void> {
  if (courseIds.length === 0) return;
  await transaction
    .insert(groupCourse)
    .values(courseIds.map((courseId) => ({ organizationId, groupId, courseId })))
    .onConflictDoNothing();
}

/** Each list a set, so a retry listing them in another order is the same request. */
function definitionDigest(definition: GroupDefinition): string {
  const sorted = (ids: readonly string[]) => [...ids].sort();
  return createHash("sha256")
    .update(
      JSON.stringify([
        definition.name,
        sorted(definition.learnerIds),
        sorted(definition.teacherIds),
        sorted(definition.courseIds),
      ]),
    )
    .digest("hex");
}

/**
 * The groups of `organizationId`, narrowed to those `teacherId` teaches there
 * and to the one `groupId` names when given; by name, each with its people by
 * name and its courses by title.
 *
 * One snapshot for the three reads: a change landing between them would
 * otherwise show a teacher a group they were just removed from, with the
 * learners just added to it.
 */
export async function readGroups(
  database: Database,
  scope: { organizationId: string; teacherId?: string; groupId?: string },
): Promise<Group[]> {
  const teaching = aliasedTable(groupMember, "teaching");

  return database.transaction(
    async (transaction) => {
      const groups = await transaction
        .select({
          id: group.id,
          organizationId: group.organizationId,
          name: group.name,
        })
        .from(group)
        .where(
          and(
            eq(group.organizationId, scope.organizationId),
            scope.groupId === undefined ? undefined : eq(group.id, scope.groupId),
            scope.teacherId === undefined
              ? undefined
              : exists(
                  transaction
                    .select({ groupId: teaching.groupId })
                    .from(teaching)
                    .where(
                      and(
                        eq(teaching.groupId, group.id),
                        eq(teaching.userId, scope.teacherId),
                        eq(teaching.role, "teacher"),
                      ),
                    ),
                ),
          ),
        )
        .orderBy(asc(group.name), asc(group.id));
      if (groups.length === 0) return [];

      // In turn, not at once: a transaction is one connection.
      const groupIds = groups.map(({ id }) => id);
      const people = await transaction
        .select({
          groupId: groupMember.groupId,
          role: groupMember.role,
          userId: groupMember.userId,
          name: user.name,
        })
        .from(groupMember)
        .innerJoin(user, eq(user.id, groupMember.userId))
        .where(inArray(groupMember.groupId, groupIds))
        .orderBy(asc(user.name), asc(groupMember.userId));
      const courses = await transaction
        .select({ groupId: groupCourse.groupId, ...COURSE_COLUMNS })
        .from(groupCourse)
        .innerJoin(course, eq(course.id, groupCourse.courseId))
        .where(inArray(groupCourse.groupId, groupIds))
        .orderBy(asc(course.title), asc(course.id));

      const peopleByGroup = Map.groupBy(people, ({ groupId }) => groupId);
      const coursesByGroup = Map.groupBy(courses, ({ groupId }) => groupId);
      const peopleIn = (groupId: string, wanted: "learner" | "teacher") =>
        (peopleByGroup.get(groupId) ?? [])
          .filter(({ role }) => role === wanted)
          .map(({ userId, name }) => ({ userId, name }));

      return groups.map((each) => ({
        ...each,
        learners: peopleIn(each.id, "learner"),
        teachers: peopleIn(each.id, "teacher"),
        courses: (coursesByGroup.get(each.id) ?? []).map(listedCourse),
      }));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The learners `teacherId` teaches in `courseId`: every learner of every group
 * they teach that takes it, once each, by name; or `undefined` when they teach
 * no group taking it, which a group with no learners yet is not. Without
 * organization roles: those are for whoever administers it (access-26).
 *
 * One query, so whom they teach and who those learners are come from one
 * moment: two reads could pair a group they were just removed from with the
 * learners just added to it.
 */
export async function readTaughtLearners(
  database: Database,
  input: { teacherId: string; courseId: string },
): Promise<GroupPerson[] | undefined> {
  const { teacherId, courseId } = input;
  const teaching = aliasedTable(groupMember, "teaching");
  const learning = aliasedTable(groupMember, "learning");

  // A row per taught group taking the course and learner in it, and one with
  // no learner for a group without any, so teaching it still shows.
  const rows = await database
    .select({ userId: learning.userId, name: user.name })
    .from(groupCourse)
    .innerJoin(
      teaching,
      and(
        eq(teaching.groupId, groupCourse.groupId),
        eq(teaching.userId, teacherId),
        eq(teaching.role, "teacher"),
      ),
    )
    .leftJoin(
      learning,
      and(eq(learning.groupId, groupCourse.groupId), eq(learning.role, "learner")),
    )
    .leftJoin(user, eq(user.id, learning.userId))
    .where(eq(groupCourse.courseId, courseId))
    .orderBy(asc(user.name), asc(learning.userId));
  if (rows.length === 0) return undefined;

  const learners = new Map<string, GroupPerson>();
  for (const { userId, name } of rows) {
    // A taught group with no learners: nobody to list.
    if (userId === null || name === null) continue;
    if (!learners.has(userId)) learners.set(userId, { userId, name });
  }
  return [...learners.values()];
}

/**
 * Whether `teacherId` teaches `learnerId` in `courseId`: whether one group has
 * the one as a teacher, the other as a learner, and takes the course.
 */
export async function teaches(
  database: Database,
  input: { teacherId: string; learnerId: string; courseId: string },
): Promise<boolean> {
  const { teacherId, learnerId, courseId } = input;
  const teaching = aliasedTable(groupMember, "teaching");
  const learning = aliasedTable(groupMember, "learning");

  const [row] = await database
    .select({ groupId: groupCourse.groupId })
    .from(groupCourse)
    .innerJoin(
      teaching,
      and(
        eq(teaching.groupId, groupCourse.groupId),
        eq(teaching.userId, teacherId),
        eq(teaching.role, "teacher"),
      ),
    )
    .innerJoin(
      learning,
      and(
        eq(learning.groupId, groupCourse.groupId),
        eq(learning.userId, learnerId),
        eq(learning.role, "learner"),
      ),
    )
    .where(eq(groupCourse.courseId, courseId))
    .limit(1);

  return row !== undefined;
}
