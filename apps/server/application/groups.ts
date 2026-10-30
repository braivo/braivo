// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { isKey, isStorableText, KEY_RULE, MAX_TITLE } from "../content/index.ts";
import {
  createGroup,
  findCreatedGroup,
  type Group,
  type GroupChange,
  type GroupDefinition,
  readCourses,
  readGroups,
  readMembers,
  readOrganizationRoles,
  updateGroup,
} from "../persistence/index.ts";
import { type AccessKind, assertMayReadLearnerData } from "./access.ts";
import { InvalidDefinition } from "./objectives.ts";
import { administers, assertMayAdminister, NotPermitted } from "./permission.ts";

/**
 * Creates a group of the organization's members taking some of its courses,
 * for whoever administers it; created again under its `key`, the same group
 * is returned (docs/adr/0024-idempotent-authoring.md). Teaching it grants
 * reading its learners' progress in its courses (docs/adr/0042-groups-scope-teaching.md).
 */
export async function defineGroup(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  key?: string;
  definition: GroupDefinition;
}): Promise<string> {
  const { database, organizationId, actingAs, key, definition } = input;

  if (key !== undefined && !isKey(key)) {
    throw new InvalidDefinition("The group", `has a key that cannot be one: ${KEY_RULE}`);
  }
  const name = checkName(definition.name);
  checkSet("learnerIds", definition.learnerIds);
  checkSet("teacherIds", definition.teacherIds);
  checkSet("courseIds", definition.courseIds);
  checkOneRole(definition.learnerIds, definition.teacherIds);
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  const checked = { ...definition, name };
  if (key !== undefined) {
    const created = await findCreatedGroup(database, { organizationId, key, definition: checked });
    if (created !== undefined) return created;
  }
  await assertInOrganization(database, organizationId, definition);

  return createGroup(database, { organizationId, key, definition: checked });
}

/**
 * Changes a group, for whoever administers its organization: renames it,
 * removes people and courses, then adds people in a role and courses. Answers
 * the group as it then stands, or `undefined` when the organization has none
 * such. Removing someone and adding them in one change sets their role;
 * adding someone already there in another is `ConflictingGroupRole`.
 * Concurrent changes apply in turn, the last one's word final (ADR 0042).
 * The answer names its people, so a tool changes one only where the
 * organization allows it (ADR 0050).
 */
export async function changeGroup(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
  groupId: string;
  change: GroupChange;
}): Promise<Group | undefined> {
  const { database, organizationId, actingAs, accessKind, groupId, change } = input;
  const { add = {}, remove = {} } = change;
  const learnerIds = add.learnerIds ?? [];
  const teacherIds = add.teacherIds ?? [];
  const courseIds = add.courseIds ?? [];

  const name = change.name === undefined ? undefined : checkName(change.name);
  checkSet("add.learnerIds", learnerIds);
  checkSet("add.teacherIds", teacherIds);
  checkSet("add.courseIds", courseIds);
  checkSet("remove.userIds", remove.userIds ?? []);
  checkSet("remove.courseIds", remove.courseIds ?? []);
  checkOneRole(learnerIds, teacherIds);
  const named = [learnerIds, teacherIds, courseIds, remove.userIds ?? [], remove.courseIds ?? []];
  if (name === undefined && named.every((ids) => ids.length === 0)) {
    throw new InvalidDefinition("The change", "names nothing to change in the group");
  }
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  // Before anything reads its people or groups, so a blocked tool learns none
  // of them from a 400 or a 404.
  await assertMayReadLearnerData(database, { organizationId, accessKind });
  await assertInOrganization(database, organizationId, { learnerIds, teacherIds, courseIds });

  if (!(await updateGroup(database, { organizationId, groupId, change: { ...change, name } }))) {
    return undefined;
  }
  // Read after: another change may land first, so this is the group now.
  const [changed] = await readGroups(database, { organizationId, groupId });
  return changed;
}

/**
 * The organization's groups: every one to whoever administers it, and to any
 * other member those they teach, none if they teach none; to a tool only where
 * the organization allows it (ADR 0050).
 */
export async function listGroups(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
}): Promise<Group[]> {
  const { database, organizationId, actingAs, accessKind } = input;

  const roles = await readOrganizationRoles(database, { organizationId, userId: actingAs });
  if (roles.length === 0) {
    throw new NotPermitted(`"${actingAs}" is not a member of organization "${organizationId}".`);
  }
  await assertMayReadLearnerData(database, { organizationId, accessKind });
  return readGroups(
    database,
    administers(roles) ? { organizationId } : { organizationId, teacherId: actingAs },
  );
}

/** The name trimmed, or `InvalidDefinition`. */
function checkName(name: string): string {
  if (!isStorableText(name, MAX_TITLE)) {
    throw new InvalidDefinition(
      "The group",
      `has a name that is blank, over ${MAX_TITLE} characters, or carries a NUL or an unpaired surrogate, which Braivo cannot store as text`,
    );
  }
  return name.trim();
}

/** Each list is a set: an ID twice is refused rather than collapsed, being more likely a mistake than meant. */
function checkSet(name: string, ids: readonly string[]): void {
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) {
    throw new InvalidDefinition("The group", `lists "${repeated}" twice in ${name}`);
  }
}

/** Refuses one person in both roles: one person has one role in a group. */
function checkOneRole(learnerIds: readonly string[], teacherIds: readonly string[]): void {
  const both = learnerIds.find((id) => teacherIds.includes(id));
  if (both !== undefined) {
    throw new InvalidDefinition(
      "The group",
      `lists "${both}" as a learner and a teacher; it can only be one`,
    );
  }
}

/**
 * Refuses people who are not the organization's members and courses that are
 * not its own. The composite foreign keys refuse them too; checked first so the
 * caller learns which, rather than meeting a constraint violation. One leaving,
 * or deleted, after this check still meets it, as with `defineCourse`.
 */
async function assertInOrganization(
  database: Database,
  organizationId: string,
  added: Pick<GroupDefinition, "learnerIds" | "teacherIds" | "courseIds">,
): Promise<void> {
  // A rename or a removal adds nothing to check.
  if (added.learnerIds.length + added.teacherIds.length + added.courseIds.length === 0) return;
  const [members, courses] = await Promise.all([
    readMembers(database, organizationId),
    readCourses(database, organizationId),
  ]);
  const memberIds = new Set(members.map(({ userId }) => userId));
  const nonMember = [...added.learnerIds, ...added.teacherIds].find((id) => !memberIds.has(id));
  if (nonMember !== undefined) {
    throw new InvalidDefinition(
      "The group",
      `lists "${nonMember}", who is not a member of the organization`,
    );
  }
  const courseIds = new Set(courses.map(({ id }) => id));
  const notOwned = added.courseIds.find((id) => !courseIds.has(id));
  if (notOwned !== undefined) {
    throw new InvalidDefinition(
      "The group",
      `lists course "${notOwned}", which is not one of the organization's`,
    );
  }
}
