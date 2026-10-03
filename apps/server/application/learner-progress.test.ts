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
import { recordGradedEvidence } from "./record-evidence.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "learner-progress-test-org";
const otherOrganizationId = "learner-progress-test-other-org";
const learner = "learner-progress-test-learner";
/** In the same organization as the learner, and so entitled to nothing about them. */
const classmate = "learner-progress-test-classmate";
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
/** The other organization's own past tense: the same title, a different objective. */
let theirPastTense!: string;

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
      learnerIds: [learner, classmate],
      adminIds: [teacher],
      at: now,
    });
    // The learner studies there too, at the same time.
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [learner],
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
    [theirPastTense] = (await createObjectives(database, otherOrganizationId, ["Past tense"])) as [
      string,
    ];
    foreignCourse = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirPastTense],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner]);
  });

  test("reports each objective in the course, in content order", async () => {
    await recordEvidence(database, { learnerId: learner, organizationId }, [
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

  test("lists the evidence behind each standing, oldest first, outcome and time alone", async () => {
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      // Recorded out of order, and one after the moment the report describes.
      evidence({ id: "second", outcome: "success", at: daysAgo(2) }),
      evidence({ id: "first", outcome: "failure", at: daysAgo(3) }),
      evidence({ id: "fraction", objectiveId: fractions, outcome: "failure", at: daysAgo(1) }),
      evidence({ id: "later", at: new Date(now.getTime() + 1000) }),
    ]);

    const read = await progress();

    expect(read.kind === "assessed" && read.report.objectives.map((each) => each.evidence)).toEqual(
      [
        [
          { outcome: "failure", at: daysAgo(3) },
          { outcome: "success", at: daysAgo(2) },
        ],
        [{ outcome: "failure", at: daysAgo(1) }],
      ],
    );
  });

  test("lists evidence at one moment in replay's order, ending on the outcome that stands", async () => {
    // Replay orders IDs by UTF-16 code unit, which puts U+10000 before U+E000;
    // a bytewise collation, such as the test database's "C", puts it after.
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      evidence({ id: "\u{10000}", outcome: "success", at: daysAgo(1) }),
      evidence({ id: "\uE000", outcome: "failure", at: daysAgo(1) }),
    ]);

    expect(await progress()).toMatchObject({
      report: {
        objectives: [
          {
            phase: "acquiring",
            evidence: [
              { outcome: "success", at: daysAgo(1) },
              { outcome: "failure", at: daysAgo(1) },
            ],
          },
          { phase: "unseen" },
        ],
      },
    });
  });

  test("describes a learner the way the decision about them does", async () => {
    // The report is built from the same replay as the decision, so whatever is
    // chosen must be visible in it as the reason for choosing it.
    await recordEvidence(database, { learnerId: learner, organizationId }, [
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
    await recordEvidence(database, { learnerId: learner, organizationId }, [
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

  test("keeps a learner's two organizations apart, though both name their evidence alike", async () => {
    // Knowledge belongs to the learner, and each organization grades only its
    // own objectives (docs/adr/0032-learner-history.md). Graders name
    // evidence independently, so one organization's ID must neither block the
    // other's write nor tell it what the learner did there.
    await recordGradedEvidence({
      database,
      organizationId,
      gradedBy: teacher,
      learnerId: learner,
      evidence: [evidence({ id: "e1", at: daysAgo(10) })],
      now,
    });
    await recordGradedEvidence({
      database,
      organizationId: otherOrganizationId,
      gradedBy: otherTeacher,
      learnerId: learner,
      evidence: [evidence({ id: "e1", objectiveId: theirPastTense, outcome: "failure" })],
      now,
    });

    expect(await progress()).toMatchObject({
      report: {
        objectives: [
          {
            objectiveId: pastTense,
            phase: "retaining",
            evidence: [{ outcome: "success", at: daysAgo(10) }],
          },
          { phase: "unseen", evidence: [] },
        ],
      },
    });
    expect(await progress({ courseId: foreignCourse, viewedBy: otherTeacher })).toMatchObject({
      report: { objectives: [{ objectiveId: theirPastTense, phase: "acquiring" }] },
    });
    // Neither administrator reads the other organization's course.
    expect(await progress({ courseId: foreignCourse })).toEqual({ kind: "unavailable" });
    expect(await progress({ viewedBy: otherTeacher })).toEqual({ kind: "unavailable" });
  });

  test("lets a learner read their own, and no other member read it", async () => {
    expect(await progress({ viewedBy: learner })).toMatchObject({ kind: "assessed" });
    expect(await progress({ viewedBy: classmate })).toEqual({ kind: "unavailable" });
    expect(await progress({ viewedBy: stranger })).toEqual({ kind: "unavailable" });
    // Reading one's own is no way around membership.
    expect(await progress({ learnerId: stranger, viewedBy: stranger })).toEqual({
      kind: "unavailable",
    });
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
