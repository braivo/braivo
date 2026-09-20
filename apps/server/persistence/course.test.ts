// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { course, courseObjective, objective, organization } from "@braivo/db/schema";
import {
  sharedDatabase,
  clearLearningData,
  seedOrganization,
  violatedConstraint,
} from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  createCourse,
  readCourseObjectives,
  readCourseOrganization,
  readCourses,
} from "./course.ts";
import { createObjectives } from "./objective.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "course-test-org";
const otherOrganizationId = "course-test-other-org";
const organizationIds = [organizationId, otherOrganizationId];
const createdAt = new Date("2026-01-01T00:00:00.000Z");

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("courses", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    for (const id of organizationIds) {
      await seedOrganization(database, { organizationId: id, learnerIds: [], at: createdAt });
    }
  });

  beforeEach(async () => {
    for (const id of organizationIds) {
      await clearLearningData(database, id);
    }
  });

  test("lists an organization's own courses by title", async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Past tense"]);
    const [theirObjective] = await createObjectives(database, otherOrganizationId, ["Past tense"]);
    const addCourse = (owner: string, title: string, objectiveId: string) =>
      createCourse(database, { organizationId: owner, title, objectiveIds: [objectiveId] });
    const zulu = await addCourse(organizationId, "Zulu", objectiveId!);
    const alpha = await addCourse(organizationId, "Alpha", objectiveId!);
    await addCourse(otherOrganizationId, "Mike", theirObjective!);

    expect(await readCourses(database, organizationId)).toEqual([
      { id: alpha, title: "Alpha" },
      { id: zulu, title: "Zulu" },
    ]);
  });

  test("returns its objectives in the order given, not by title or ID", async () => {
    // Titles chosen so that alphabetical order is not the order asked for: if
    // position were being ignored, this would come back sorted.
    const [zulu, alpha, mike] = await createObjectives(database, organizationId, [
      "Zulu",
      "Alpha",
      "Mike",
    ]);
    const courseId = await createCourse(database, {
      organizationId,
      title: "Ordered",
      objectiveIds: [mike!, zulu!, alpha!],
    });

    expect(await readCourseObjectives(database, courseId)).toEqual([mike!, zulu!, alpha!]);
  });

  test("lets one objective sit at a different position in each course", async () => {
    // A course orders objectives, it does not own them — the same knowledge
    // taught in two courses is still one objective and one estimate.
    const [alpha, bravo] = await createObjectives(database, organizationId, ["Alpha", "Bravo"]);
    const first = await createCourse(database, {
      organizationId,
      title: "First",
      objectiveIds: [alpha!, bravo!],
    });
    const second = await createCourse(database, {
      organizationId,
      title: "Second",
      objectiveIds: [bravo!, alpha!],
    });

    expect(await readCourseObjectives(database, first)).toEqual([alpha!, bravo!]);
    expect(await readCourseObjectives(database, second)).toEqual([bravo!, alpha!]);
  });

  test("refuses the same objective twice in one course", async () => {
    const [alpha] = await createObjectives(database, organizationId, ["Alpha"]);

    const error = await createCourse(database, {
      organizationId,
      title: "Duplicated",
      objectiveIds: [alpha!, alpha!],
    }).catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_course_id_objective_id_pk");
  });

  test("refuses to arrange another organization's objective", async () => {
    // Plain foreign keys would accept this, since both rows exist. Matching the
    // organization on both references is what refuses it — otherwise selection
    // could hand a learner an objective from an organization they have nothing
    // to do with, and authorizing the course alone would not have caught it.
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);

    const error = await createCourse(database, {
      organizationId,
      title: "Borrowed",
      objectiveIds: [theirs!],
    }).catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");
  });

  test("refuses two objectives at the same position in one course", async () => {
    // `createCourse` never writes this, so only a direct insert can show the
    // database refusing it.
    const [alpha, bravo] = await createObjectives(database, organizationId, ["Alpha", "Bravo"]);
    const courseId = await createCourse(database, {
      organizationId,
      title: "Clash",
      objectiveIds: [alpha!],
    });

    const error = await database
      .insert(courseObjective)
      .values({ organizationId, courseId, objectiveId: bravo!, position: 0 })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_position_uidx");
  });

  test("refuses to attach an objective to another organization's course", async () => {
    // The other half of matching organizations: the objective is this
    // organization's, and the course is not.
    const [mine] = await createObjectives(database, organizationId, ["Mine"]);
    const theirs = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [],
    });

    const error = await database
      .insert(courseObjective)
      .values({ organizationId, courseId: theirs, objectiveId: mine!, position: 0 })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_objective_course_fk");
  });

  test("refuses to delete an objective a course uses, but not the course", async () => {
    const [objectiveId] = await createObjectives(database, organizationId, ["Past tense"]);
    const courseId = await createCourse(database, {
      organizationId,
      title: "Grammar",
      objectiveIds: [objectiveId!],
    });
    const deleteObjective = () => database.delete(objective).where(eq(objective.id, objectiveId!));

    const error = await deleteObjective().catch((thrown: unknown) => thrown);
    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");

    await database.delete(course).where(eq(course.id, courseId));
    expect(
      await database.select().from(courseObjective).where(eq(courseObjective.courseId, courseId)),
    ).toEqual([]);
    await deleteObjective();
  });

  test("refuses to delete an organization that still owns a course", async () => {
    await createCourse(database, { organizationId, title: "Empty", objectiveIds: [] });

    const error = await database
      .delete(organization)
      .where(eq(organization.id, organizationId))
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("course_organization_id_organization_id_fk");
  });

  test("rolls the course back when its objectives cannot be attached", async () => {
    // A course that lost its membership is not a shorter course; selection would
    // read it as a course with nothing left to teach.
    const error = await createCourse(database, {
      organizationId,
      title: "Doomed",
      objectiveIds: ["no-such-objective"],
    }).catch((thrown: unknown) => thrown);

    // Assert which insert failed: without this the table would also be empty if
    // creation had failed before the course row was ever written.
    expect(violatedConstraint(error)).toBe("course_objective_objective_fk");
    expect(
      await database.select().from(course).where(eq(course.organizationId, organizationId)),
    ).toEqual([]);
  });

  test("allows a course with no objectives yet", async () => {
    const courseId = await createCourse(database, {
      organizationId,
      title: "Empty",
      objectiveIds: [],
    });

    expect(await readCourseObjectives(database, courseId)).toEqual([]);
  });

  test("returns nothing for a course that does not exist", async () => {
    expect(await readCourseObjectives(database, "no-such-course")).toEqual([]);
  });

  test("reports which organization owns a course", async () => {
    const courseId = await createCourse(database, {
      organizationId,
      title: "Owned",
      objectiveIds: [],
    });

    expect(await readCourseOrganization(database, courseId)).toBe(organizationId);
  });

  test("reports no owner for a course that does not exist", async () => {
    expect(await readCourseOrganization(database, "no-such-course")).toBeUndefined();
  });
});
