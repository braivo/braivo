// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Group, GroupChange, GroupDefinition } from "@braivo/server/client";

export type GroupRole = "teacher" | "learner";

/** What a group form holds before saving: the group's people and courses, by ID. */
export type Roster = Pick<Group, "teachers" | "learners" | "courses">;

/**
 * What someone changed in a group form, over the group as loaded: each person
 * touched, in a role or removed (`null`), each course touched, in or out.
 * Kept apart from the group, so reloading it after a conflict or an
 * unconfirmed save keeps them, and saving sends them alone (ADR 0042: changes
 * are deltas, the last writer's word final).
 */
export type GroupEdits = {
  people: Readonly<Record<string, GroupRole | null>>;
  courses: Readonly<Record<string, boolean>>;
};

export const NO_EDITS: GroupEdits = { people: {}, courses: {} };

/** No one and nothing: where a new group starts. */
export const NO_ROSTER: Roster = { teachers: [], learners: [], courses: [] };

/** Each person's role in `roster`, by user ID. */
function rolesOf(roster: Roster): Map<string, GroupRole> {
  return new Map([
    ...roster.teachers.map(({ userId }) => [userId, "teacher"] as const),
    ...roster.learners.map(({ userId }) => [userId, "learner"] as const),
  ]);
}

/**
 * `edits` less what `roster` already holds: an edit undone, or made by someone
 * else meanwhile. Kept so after every edit and every reload, only what is
 * still to be sent is ever carried onto a newer group: an undone edit carried
 * over would be sent as a new one, restoring access someone removed.
 */
export function outstanding(roster: Roster, edits: GroupEdits): GroupEdits {
  const roles = rolesOf(roster);
  const courses = new Set(roster.courses.map(({ id }) => id));
  return {
    people: Object.fromEntries(
      Object.entries(edits.people).filter(([userId, role]) => role !== (roles.get(userId) ?? null)),
    ),
    courses: Object.fromEntries(
      Object.entries(edits.courses).filter(([courseId, taken]) => taken !== courses.has(courseId)),
    ),
  };
}

/**
 * Whom `edits` adds in a role that `now` holds them in the other, though
 * `before`, the group the edit was made over, did not hold them: someone else
 * added them meanwhile, and the change would replace their role (access-38).
 */
export function conflictingUserIds(before: Roster, now: Roster, edits: GroupEdits): string[] {
  const was = rolesOf(before);
  const is = rolesOf(now);
  return Object.entries(edits.people)
    .filter(
      ([userId, role]) => role && !was.has(userId) && is.has(userId) && is.get(userId) !== role,
    )
    .map(([userId]) => userId);
}

/** The roster as the form shows it: `roster` with `edits` applied, by ID. */
export function edited(
  roster: Roster,
  edits: GroupEdits,
): { teacherIds: string[]; learnerIds: string[]; courseIds: string[] } {
  const roles = rolesOf(roster);
  for (const [userId, role] of Object.entries(edits.people)) {
    if (role) roles.set(userId, role);
    else roles.delete(userId);
  }
  const courses = new Set(roster.courses.map(({ id }) => id));
  for (const [courseId, taken] of Object.entries(edits.courses)) {
    if (taken) courses.add(courseId);
    else courses.delete(courseId);
  }
  const holding = (wanted: GroupRole) =>
    [...roles].filter(([, role]) => role === wanted).map(([userId]) => userId);
  return {
    teacherIds: holding("teacher"),
    learnerIds: holding("learner"),
    courseIds: [...courses],
  };
}

/** A new group: everything in `edits`. */
export function definitionOf(name: string, edits: GroupEdits): GroupDefinition {
  return { name, ...edited(NO_ROSTER, edits) };
}

/**
 * The change that turns `group` into what the form shows, naming only what
 * differs from it; `undefined` when nothing does. A person whose role changes
 * is removed and added in one change, which is how a role changes (access-38).
 */
export function changeOf(
  group: Roster & { name: string },
  name: string,
  edits: GroupEdits,
): GroupChange | undefined {
  const roles = rolesOf(group);
  const courses = new Set(group.courses.map(({ id }) => id));
  const userIds: string[] = [];
  const teacherIds: string[] = [];
  const learnerIds: string[] = [];
  for (const [userId, role] of Object.entries(edits.people)) {
    const was = roles.get(userId);
    if (role === (was ?? null)) continue;
    if (was) userIds.push(userId);
    if (role === "teacher") teacherIds.push(userId);
    if (role === "learner") learnerIds.push(userId);
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const [courseId, taken] of Object.entries(edits.courses)) {
    if (taken && !courses.has(courseId)) added.push(courseId);
    if (!taken && courses.has(courseId)) removed.push(courseId);
  }

  const change: GroupChange = {
    ...(name !== group.name && { name }),
    ...((teacherIds.length > 0 || learnerIds.length > 0 || added.length > 0) && {
      add: {
        ...(teacherIds.length > 0 && { teacherIds }),
        ...(learnerIds.length > 0 && { learnerIds }),
        ...(added.length > 0 && { courseIds: added }),
      },
    }),
    ...((userIds.length > 0 || removed.length > 0) && {
      remove: {
        ...(userIds.length > 0 && { userIds }),
        ...(removed.length > 0 && { courseIds: removed }),
      },
    }),
  };
  return Object.keys(change).length > 0 ? change : undefined;
}
