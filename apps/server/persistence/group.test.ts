// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { course, groupCourse, groupMember, member } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase, violatedConstraint } from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vite-plus/test";

import { createCourse } from "./course.ts";
import { createGroup, type GroupDefinition, readGroups, readTaughtLearners } from "./group.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "group-test-org";
const otherOrganizationId = "group-test-other-org";
const teacher = "group-test-teacher";
const ana = "group-test-ana";
/** A member of the other organization only. */
const stranger = "group-test-stranger";
const at = new Date("2026-01-01T00:00:00.000Z");

let courseId!: string;

const definition = (overrides: Partial<GroupDefinition> = {}): GroupDefinition => ({
  name: "7A",
  learnerIds: [ana],
  teacherIds: [teacher],
  courseIds: [courseId],
  ...overrides,
});

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("groups", () => {
  beforeEach(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds: [teacher, ana], at });
    await seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [stranger],
      at,
    });
    courseId = await createCourse(database, { organizationId, title: "Spanish", objectiveIds: [] });
  });

  test("refuses, in the schema, a group member who is not the organization's", async () => {
    const groupId = await createGroup(database, { organizationId, definition: definition() });

    const inserting = database
      .insert(groupMember)
      .values({ organizationId, groupId, userId: stranger, role: "learner" });
    expect(violatedConstraint(await inserting.catch((error: unknown) => error))).toBe(
      "group_member_member_fk",
    );
  });

  test("refuses, in the schema, a group course that is not the organization's", async () => {
    const groupId = await createGroup(database, { organizationId, definition: definition() });
    const foreignCourseId = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "French",
      objectiveIds: [],
    });

    const inserting = database
      .insert(groupCourse)
      .values({ organizationId, groupId, courseId: foreignCourseId });
    expect(violatedConstraint(await inserting.catch((error: unknown) => error))).toBe(
      "group_course_course_fk",
    );
  });

  test("takes people out of its groups when they leave the organization", async () => {
    await createGroup(database, { organizationId, definition: definition() });

    await database
      .delete(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, ana)));

    const [read] = await readGroups(database, { organizationId });
    expect(read?.learners).toEqual([]);
    expect(await readTaughtLearners(database, { teacherId: teacher, courseId })).toEqual([]);
  });

  test("takes a deleted course out of its groups", async () => {
    await createGroup(database, { organizationId, definition: definition() });

    await database.delete(course).where(eq(course.id, courseId));

    const [read] = await readGroups(database, { organizationId });
    expect(read?.courses).toEqual([]);
    expect(await readTaughtLearners(database, { teacherId: teacher, courseId })).toBeUndefined();
  });

  test("creates one group for two requests racing under one key", async () => {
    const create = () =>
      createGroup(database, { organizationId, key: "7a", definition: definition() });

    const [first, second] = await Promise.all([create(), create()]);

    expect(second).toBe(first);
    expect(await readGroups(database, { organizationId })).toHaveLength(1);
  });
});
