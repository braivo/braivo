// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createObjectives, readCourseObjectives } from "../persistence/index.ts";
import { defineCourse, listCourses } from "./courses.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "courses-test-org";
const otherOrganizationId = "courses-test-other-org";
/** An admin, and so someone who may create courses for the organization. */
const author = "courses-test-author";
/** A member, and so someone who may only study. */
const learner = "courses-test-learner";
const at = new Date("2026-01-01T00:00:00.000Z");

let alpha!: string;
let bravo!: string;
let theirs!: string;

function define(objectiveIds: readonly string[], actingAs = author, title = "Spanish") {
  return defineCourse({ database, organizationId, actingAs, title, objectiveIds });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("defining courses", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await database
      .insert(authTables.user)
      .values({
        id: "courses-test-outsider",
        name: "courses-test-outsider",
        email: "courses-test-outsider@example.com",
        emailVerified: false,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [author],
      at,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at,
    });

    const ours = await createObjectives(database, organizationId, ["Alpha", "Bravo"]);
    alpha = ours[0]!;
    bravo = ours[1]!;
    theirs = (await createObjectives(database, otherOrganizationId, ["Theirs"]))[0]!;
  });

  test("creates a course in the order it was given, and lists it", async () => {
    // Titles chosen so alphabetical order is not the order asked for: position
    // is content order, and content order is what selection reads.
    const courseId = await define([bravo, alpha]);

    expect(await readCourseObjectives(database, courseId)).toEqual([bravo!, alpha!]);
    expect(await listCourses({ database, organizationId, actingAs: author })).toEqual([
      { id: courseId, title: "Spanish" },
    ]);
  });

  test("refuses an objective another organization owns, as a refusal", async () => {
    // The composite foreign keys would refuse this anyway, but as a constraint
    // violation — a 500 for what is really an answer. Asking first keeps it one.
    const rejected = define([alpha, theirs]);

    await expect(rejected).rejects.toBeInstanceOf(NotPermitted);
    await expect(rejected).rejects.toThrow(theirs);
    expect(await listCourses({ database, organizationId, actingAs: author })).toEqual([]);
  });

  test("lets an owner create a course", async () => {
    // Every use case shares this rule, so one owner is enough to pin it.
    await database
      .update(member)
      .set({ role: "owner" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author)));

    await expect(define([alpha])).resolves.toEqual(expect.any(String));
  });

  test("asks who is acting before whose objectives these are", async () => {
    await expect(define([theirs], learner)).rejects.toThrow(`"${learner}" may not act`);
  });

  test("refuses an objective listed twice, before asking who is acting", async () => {
    await expect(define([alpha, bravo, alpha], learner)).rejects.toBeInstanceOf(RangeError);
  });

  test("refuses an objective that does not exist", async () => {
    await expect(define(["no-such-objective"])).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses a learner creating a course", async () => {
    await expect(define([alpha], learner)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses someone outside the organization", async () => {
    await expect(define([alpha], "courses-test-outsider")).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses to list for anyone who may not administer", async () => {
    await expect(
      listCourses({ database, organizationId, actingAs: learner }),
    ).rejects.toBeInstanceOf(NotPermitted);
  });

  test("allows a course with no objectives yet", async () => {
    const courseId = await define([]);

    expect(await readCourseObjectives(database, courseId)).toEqual([]);
  });
});
