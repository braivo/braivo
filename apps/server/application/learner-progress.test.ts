// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence, REPEATED_MISSES_THRESHOLD } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import type { AccessKind } from "./access.ts";
import { submitAttempt } from "./activity.ts";
import { readLearnerProgress, withoutHistory } from "./learner-progress.ts";
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
/** Another course of the organization, teaching the past tense too. */
let reviewCourse!: string;
let pastTenseTask!: string;
let foreignCourse!: string;
/** The other organization's own past tense: the same title, a different objective. */
let theirPastTense!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: now, ...overrides };
}

function progress(
  input: { courseId?: string; learnerId?: string; viewedBy?: string; accessKind?: AccessKind } = {},
) {
  return readLearnerProgress({
    database,
    viewedBy: input.viewedBy ?? teacher,
    accessKind: input.accessKind ?? "browser",
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
    course = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Both",
        objectiveIds: [pastTense, fractions],
      })
    ).id;
    emptyCourse = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Empty",
        objectiveIds: [],
      })
    ).id;
    reviewCourse = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Review",
        objectiveIds: [pastTense],
      })
    ).id;
    pastTenseTask = await testing.createTask(database, {
      organizationId,
      objectiveId: pastTense,
      body: { kind: "choice", prompt: "Went?", options: ["right", "wrong"], answer: 0 },
      createdAt: daysAgo(30),
    });
    [theirPastTense] = (await createObjectives(database, otherOrganizationId, ["Past tense"])) as [
      string,
    ];
    foreignCourse = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [theirPastTense],
      })
    ).id;
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
      timeZone: "UTC",
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
      report: {
        modelVersion: activeModel.version,
        asOf: now,
        repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
        lastPractisedAt: null,
        objectives: [],
      },
    });
  });

  test("counts misses since the last success from every course and grader at the organization", async () => {
    // An outside grader's failure, then Show answer in another course that
    // teaches the objective, then a failure recorded here.
    await recordGradedEvidence({
      database,
      organizationId,
      gradedBy: teacher,
      learnerId: learner,
      evidence: [evidence({ id: "graded", outcome: "failure", at: daysAgo(3) })],
      now,
    });
    expect(
      await submitAttempt({
        database,
        learnerId: learner,
        courseId: reviewCourse,
        host: { hostname: "localhost", installation: true },
        attemptId: "shown",
        taskId: pastTenseTask,
        response: { reveal: true },
        now: daysAgo(2),
      }),
    ).toMatchObject({ kind: "graded", grade: { outcome: "failure" } });
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      evidence({ id: "third", outcome: "failure", at: daysAgo(1) }),
      // After the moment described: not counted.
      evidence({ id: "later", outcome: "failure", at: new Date(now.getTime() + 1000) }),
    ]);
    // The other organization's failures are its own.
    await recordEvidence(database, { learnerId: learner, organizationId: otherOrganizationId }, [
      evidence({ id: "theirs", objectiveId: theirPastTense, outcome: "failure", at: daysAgo(1) }),
    ]);

    const read = await progress();
    if (read.kind !== "assessed") throw new Error("No report");
    const [past, fraction] = read.report.objectives;
    expect(past).toMatchObject({
      phase: "acquiring",
      misses: { count: 3, lastMissAt: daysAgo(1), everSucceeded: false },
    });
    // No miss, no field.
    expect(fraction).not.toHaveProperty("misses");
    expect(read.report).toMatchObject({
      asOf: now,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
    });
    // A summary, not the records: kept in a report without its evidence.
    expect(withoutHistory(read.report)).toMatchObject({
      asOf: now,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      objectives: [{ misses: { count: 3 } }, {}],
    });
  });

  test("says when the learner last answered here, Show answer and other courses included, outside results not", async () => {
    // An outside grader's result, then Show answer in another course on a shared objective.
    await recordGradedEvidence({
      database,
      organizationId,
      gradedBy: teacher,
      learnerId: learner,
      evidence: [evidence({ id: "graded", outcome: "success", at: daysAgo(3) })],
      now,
    });
    expect(await progress()).toMatchObject({ report: { lastPractisedAt: null } });
    await submitAttempt({
      database,
      learnerId: learner,
      courseId: reviewCourse,
      host: { hostname: "localhost", installation: true },
      attemptId: "shown",
      taskId: pastTenseTask,
      response: { reveal: true },
      now: daysAgo(2),
    });
    // A later outside result changes nothing.
    await recordGradedEvidence({
      database,
      organizationId,
      gradedBy: teacher,
      learnerId: learner,
      evidence: [evidence({ id: "later-graded", outcome: "success", at: daysAgo(1) })],
      now,
    });

    const read = await progress();
    if (read.kind !== "assessed") throw new Error("No report");
    expect(read.report.lastPractisedAt).toEqual(daysAgo(2));
    // Kept without the history, as the learn app reads it.
    expect(withoutHistory(read.report).lastPractisedAt).toEqual(daysAgo(2));
  });

  test("counts misses from the latest success, which one more success clears", async () => {
    await recordEvidence(database, { learnerId: learner, organizationId }, [
      evidence({ id: "a", outcome: "failure", at: daysAgo(5) }),
      evidence({ id: "b", outcome: "success", at: daysAgo(4) }),
      evidence({ id: "c", outcome: "failure", at: daysAgo(3) }),
      evidence({ id: "d", outcome: "failure", at: daysAgo(2) }),
    ]);
    expect(await progress()).toMatchObject({
      report: {
        objectives: [{ misses: { count: 2, lastMissAt: daysAgo(2), everSucceeded: true } }, {}],
      },
    });

    await recordEvidence(database, { learnerId: learner, organizationId }, [
      evidence({ id: "e", outcome: "success", at: daysAgo(1) }),
    ]);
    const read = await progress();
    expect(read.kind === "assessed" && read.report.objectives[0]).not.toHaveProperty("misses");
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

  describe("through a tool (access-45)", () => {
    let closedCourse!: string;

    beforeAll(async () => {
      closedCourse = (
        await createCourse(database, {
          published: false,
          organizationId,
          title: "Closed",
          objectiveIds: [pastTense],
        })
      ).id;
    });

    beforeEach(async () => {
      await testing.setToolsReadLearnerData(database, organizationId, false);
    });

    test("refuses another's report while the organization does not allow it, as a missing course", async () => {
      expect(await progress({ accessKind: "tool" })).toEqual(
        await progress({ accessKind: "tool", courseId: "no-such-course" }),
      );
      expect(await progress({ accessKind: "tool" })).toEqual({ kind: "unavailable" });
      expect(await progress({ accessKind: "browser" })).toMatchObject({ kind: "assessed" });
    });

    test("reads another's report once the organization allows it, and no further", async () => {
      await testing.setToolsReadLearnerData(database, organizationId, true);

      expect(await progress({ accessKind: "tool" })).toEqual(
        await progress({ accessKind: "browser" }),
      );
      expect(await progress({ accessKind: "tool" })).toMatchObject({ kind: "assessed" });
      // The setting adds no reader: roles and teaching still decide.
      expect(await progress({ accessKind: "tool", viewedBy: classmate })).toEqual({
        kind: "unavailable",
      });
    });

    test("reads the learner's own report either way, under every other check", async () => {
      expect(await progress({ accessKind: "tool", viewedBy: learner })).toMatchObject({
        kind: "assessed",
      });
      expect(
        await progress({ accessKind: "tool", viewedBy: learner, courseId: closedCourse }),
      ).toEqual({ kind: "unavailable" });
    });
  });
});
