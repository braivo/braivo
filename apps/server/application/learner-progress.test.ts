// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import { readLearnerProgress } from "./learner-progress.ts";
import { chooseNextObjective } from "./next-objective.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "learner-progress-test-org";
const otherOrganizationId = "learner-progress-test-other-org";
const learner = "learner-progress-test-learner";
/** Administers the organization, and so may read its learners' progress. */
const teacher = "learner-progress-test-teacher";
/** Administers a different organization, which gives them nothing here. */
const otherTeacher = "learner-progress-test-other-teacher";
/** A real user in no organization at all. */
const stranger = "learner-progress-test-stranger";
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let pastTense!: string;
let fractions!: string;
let course!: string;
let emptyCourse!: string;
let foreignCourse!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: now, ...overrides };
}

function progress(input: { courseId?: string; learnerId?: string; viewedBy?: string } = {}) {
  return readLearnerProgress({
    database,
    viewedBy: input.viewedBy ?? teacher,
    learnerId: input.learnerId ?? learner,
    courseId: input.courseId ?? course,
    host: { hostname: "localhost", installation: true },
    now,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("reading a learner's progress", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [teacher],
      at: now,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      adminIds: [otherTeacher],
      at: now,
    });
    await database
      .insert(authTables.user)
      .values({
        id: stranger,
        name: stranger,
        email: `${stranger}@example.com`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    [pastTense, fractions] = (await createObjectives(database, organizationId, [
      "Past tense",
      "Fractions",
    ])) as [string, string];
    course = await createCourse(database, {
      organizationId,
      title: "Both",
      objectiveIds: [pastTense, fractions],
    });
    emptyCourse = await createCourse(database, {
      organizationId,
      title: "Empty",
      objectiveIds: [],
    });
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourse = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirs!],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner]);
  });

  test("reports each objective in the course, in content order", async () => {
    await recordEvidence(database, learner, [
      evidence({ id: "kept", objectiveId: pastTense, at: daysAgo(10) }),
    ]);

    expect(await progress()).toMatchObject({
      kind: "assessed",
      report: {
        modelVersion: activeModel.version,
        objectives: [
          // One success ten days ago: stability 1, so well below target.
          { objectiveId: pastTense, phase: "retaining", stability: 1, due: true },
          { objectiveId: fractions, phase: "unseen" },
        ],
      },
    });
  });

  test("describes a learner the way the decision about them does", async () => {
    // The report is built from the same replay as the decision, so whatever is
    // chosen must be visible in it as the reason for choosing it.
    await recordEvidence(database, learner, [
      evidence({ id: "due", objectiveId: pastTense, at: daysAgo(10) }),
      evidence({ id: "failed", objectiveId: fractions, outcome: "failure", at: daysAgo(1) }),
    ]);

    const next = await chooseNextObjective({
      database,
      learnerId: learner,
      courseId: course,
      host: { hostname: "localhost", installation: true },
      now,
    });
    const read = await progress();

    expect(next).toMatchObject({ kind: "decided", decision: { objectiveId: fractions } });
    expect(read).toMatchObject({
      report: { objectives: [{ phase: "retaining", due: true }, { phase: "acquiring" }] },
    });
  });

  test("leaves out evidence dated after the moment it describes", async () => {
    await recordEvidence(database, learner, [
      evidence({ id: "later", outcome: "failure", at: new Date(now.getTime() + 1000) }),
    ]);

    expect(await progress()).toMatchObject({
      report: { objectives: [{ phase: "unseen" }, { phase: "unseen" }] },
    });
  });

  test("reports nothing, rather than refusing, for a course that teaches nothing yet", async () => {
    expect(await progress({ courseId: emptyCourse })).toEqual({
      kind: "assessed",
      report: { modelVersion: activeModel.version, objectives: [] },
    });
  });

  test("refuses a reader who does not administer the organization", async () => {
    // Including the learner reading their own: a member does not administer,
    // and self-service is not what this covers.
    expect(await progress({ viewedBy: learner })).toEqual({ kind: "unavailable" });
    expect(await progress({ viewedBy: stranger })).toEqual({ kind: "unavailable" });
  });

  test("refuses the administrator of a different organization", async () => {
    // Administering somewhere is not administering here.
    expect(await progress({ viewedBy: otherTeacher })).toEqual({ kind: "unavailable" });
  });

  test("answers a missing course exactly as it answers one the reader may not see", async () => {
    expect(await progress({ courseId: "no-such-course" })).toEqual(
      await progress({ courseId: foreignCourse }),
    );
  });

  test("answers a learner outside the organization as it answers an ID nobody has", async () => {
    // An administrator can see their own members, but telling these two apart
    // would let them test whether an ID exists anywhere.
    const outside = await progress({ learnerId: stranger });

    expect(outside).toEqual({ kind: "unavailable" });
    expect(await progress({ learnerId: "nobody-has-this-id" })).toEqual(outside);
  });
});
