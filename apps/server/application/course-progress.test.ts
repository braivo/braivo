// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import { readCourseProgress } from "./course-progress.ts";
import { readLearnerProgress } from "./learner-progress.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "course-progress-test-org";
const otherOrganizationId = "course-progress-test-other-org";
const ana = "course-progress-test-ana";
const ben = "course-progress-test-ben";
/** Administers the organization, and so may read the overview. */
const teacher = "course-progress-test-teacher";
/** Administers a different organization, which gives them nothing here. */
const otherTeacher = "course-progress-test-other-teacher";
const installation = { hostname: "localhost", installation: true };
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let greetings!: string;
let numbers!: string;
let colours!: string;
/** The organization's, but outside the course. */
let weather!: string;
let course!: string;
let foreignCourse!: string;
let theirGreetings!: string;

function evidence(overrides: Partial<Evidence> & Pick<Evidence, "id" | "objectiveId">): Evidence {
  return { outcome: "success", at: now, ...overrides };
}

function overview(
  input: { courseId?: string; viewedBy?: string; host?: typeof installation } = {},
) {
  return readCourseProgress({
    database,
    viewedBy: input.viewedBy ?? teacher,
    courseId: input.courseId ?? course,
    host: input.host ?? installation,
    now,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("reading a course's progress", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [ben, ana],
      adminIds: [teacher],
      at: now,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [ana],
      adminIds: [otherTeacher],
      at: now,
    });

    [greetings, numbers, colours, weather] = (await createObjectives(database, organizationId, [
      "Greetings",
      "Numbers",
      "Colours",
      "Weather",
    ])) as [string, string, string, string];
    course = await createCourse(database, {
      organizationId,
      title: "Beginners",
      objectiveIds: [greetings, numbers, colours],
    });
    [theirGreetings] = (await createObjectives(database, otherOrganizationId, ["Greetings"])) as [
      string,
    ];
    foreignCourse = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirGreetings],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [ana, ben]);
  });

  test("counts each learner's standings as their own report shows them", async () => {
    await recordEvidence(database, { learnerId: ana, organizationId }, [
      // One success ten days ago: stability 1, so due.
      evidence({ id: "a1", objectiveId: greetings, at: daysAgo(10) }),
      evidence({ id: "a2", objectiveId: numbers, outcome: "failure", at: daysAgo(1) }),
      // The organization's, outside the course: never counted.
      evidence({ id: "a3", objectiveId: weather, outcome: "failure", at: daysAgo(1) }),
    ]);
    await recordEvidence(database, { learnerId: ben, organizationId }, [
      evidence({ id: "b1", objectiveId: greetings, at: daysAgo(1) }),
      evidence({ id: "b2", objectiveId: numbers, at: daysAgo(1) }),
      // After the moment described, so not counted.
      evidence({ id: "b3", objectiveId: colours, at: new Date(now.getTime() + 1000) }),
    ]);
    // At another organization, so not counted here.
    await recordEvidence(database, { learnerId: ana, organizationId: otherOrganizationId }, [
      evidence({ id: "a1", objectiveId: theirGreetings, outcome: "failure" }),
    ]);

    const read = await overview();

    expect(read).toEqual({
      kind: "assessed",
      overview: {
        modelVersion: activeModel.version,
        learners: [
          {
            userId: ana,
            name: ana,
            roles: ["member"],
            standings: { unseen: 1, acquiring: 1, retained: 0, due: 1 },
          },
          {
            userId: ben,
            name: ben,
            roles: ["member"],
            standings: { unseen: 1, acquiring: 0, retained: 2, due: 0 },
          },
          {
            userId: teacher,
            name: teacher,
            roles: ["admin"],
            standings: { unseen: 3, acquiring: 0, retained: 0, due: 0 },
          },
        ],
      },
    });
    // Each overview count must equal that learner's report at the same `now`.
    for (const learner of read.kind === "assessed" ? read.overview.learners : []) {
      const report = await readLearnerProgress({
        database,
        viewedBy: teacher,
        learnerId: learner.userId,
        courseId: course,
        host: installation,
        now,
      });
      if (report.kind !== "assessed") throw new Error(`No report for ${learner.userId}`);
      const phases = report.report.objectives.map((standing) =>
        standing.phase !== "retaining" ? standing.phase : standing.due ? "due" : "retained",
      );
      expect(learner.standings).toEqual({
        unseen: phases.filter((phase) => phase === "unseen").length,
        acquiring: phases.filter((phase) => phase === "acquiring").length,
        retained: phases.filter((phase) => phase === "retained").length,
        due: phases.filter((phase) => phase === "due").length,
      });
    }
  });

  test("shows the overview to the organization's administrators only", async () => {
    expect(await overview()).toMatchObject({ kind: "assessed" });
    // A member sees their own report, never the others'.
    expect(await overview({ viewedBy: ana })).toEqual({ kind: "unavailable" });
    expect(await overview({ viewedBy: otherTeacher })).toEqual({ kind: "unavailable" });
    expect(await overview({ courseId: foreignCourse })).toEqual({ kind: "unavailable" });
  });

  test("answers a missing course, and one on a host that does not reach it, as a refused one", async () => {
    expect(await overview({ courseId: "no-such-course" })).toEqual({ kind: "unavailable" });
    expect(
      await overview({ host: { hostname: "elsewhere.example", installation: false } }),
    ).toEqual({ kind: "unavailable" });
  });
});
