// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence, REPEATED_MISSES_THRESHOLD } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import type { AccessKind } from "./access.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
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
let emptyCourse!: string;
let foreignCourse!: string;
let theirGreetings!: string;

function evidence(overrides: Partial<Evidence> & Pick<Evidence, "id" | "objectiveId">): Evidence {
  return { outcome: "success", at: now, ...overrides };
}

function overview(
  input: {
    courseId?: string;
    viewedBy?: string;
    accessKind?: AccessKind;
    host?: typeof installation;
  } = {},
) {
  return readCourseProgress({
    database,
    viewedBy: input.viewedBy ?? teacher,
    accessKind: input.accessKind ?? "browser",
    courseId: input.courseId ?? course,
    host: input.host ?? installation,
    now,
  });
}

/** Each standing's count, summed over the rows. */
function totals(
  rows: readonly { standings: Record<"unseen" | "acquiring" | "retained" | "due", number> }[],
) {
  return rows.reduce(
    (sum, { standings }) => ({
      unseen: sum.unseen + standings.unseen,
      acquiring: sum.acquiring + standings.acquiring,
      retained: sum.retained + standings.retained,
      due: sum.due + standings.due,
    }),
    { unseen: 0, acquiring: 0, retained: 0, due: 0 },
  );
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
    course = (
      await createCourse(database, {
        published: true,
        organizationId,
        title: "Beginners",
        objectiveIds: [greetings, numbers, colours],
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
    [theirGreetings] = (await createObjectives(database, otherOrganizationId, ["Greetings"])) as [
      string,
    ];
    foreignCourse = (
      await createCourse(database, {
        published: true,
        organizationId: otherOrganizationId,
        title: "Theirs",
        objectiveIds: [theirGreetings],
      })
    ).id;
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [ana, ben]);
  });

  test("counts the same standings per learner and per objective, in content order", async () => {
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
        open: true,
        modelVersion: activeModel.version,
        asOf: now,
        repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
        // Results recorded through the API, none an attempt answered here.
        learners: [
          {
            userId: ana,
            name: ana,
            roles: ["member"],
            standings: { unseen: 1, acquiring: 1, retained: 0, due: 1 },
            repeatedMisses: 0,
            lastPractisedAt: null,
          },
          {
            userId: ben,
            name: ben,
            roles: ["member"],
            standings: { unseen: 1, acquiring: 0, retained: 2, due: 0 },
            repeatedMisses: 0,
            lastPractisedAt: null,
          },
          {
            userId: teacher,
            name: teacher,
            roles: ["admin"],
            standings: { unseen: 3, acquiring: 0, retained: 0, due: 0 },
            repeatedMisses: 0,
            lastPractisedAt: null,
          },
        ],
        objectives: [
          {
            objectiveId: greetings,
            title: "Greetings",
            standings: { unseen: 1, acquiring: 0, retained: 1, due: 1 },
            repeatedMisses: [],
          },
          {
            objectiveId: numbers,
            title: "Numbers",
            standings: { unseen: 1, acquiring: 1, retained: 1, due: 0 },
            repeatedMisses: [],
          },
          {
            objectiveId: colours,
            title: "Colours",
            standings: { unseen: 3, acquiring: 0, retained: 0, due: 0 },
            repeatedMisses: [],
          },
        ],
      },
    });
    // Per objective or per learner, the same standings are counted.
    if (read.kind === "assessed") {
      expect(totals(read.overview.objectives)).toEqual(totals(read.overview.learners));
    }
    // Each overview count must equal that learner's report at the same `now`.
    for (const learner of read.kind === "assessed" ? read.overview.learners : []) {
      const report = await readLearnerProgress({
        database,
        viewedBy: teacher,
        accessKind: "browser",
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

  test("names each objective's learners with repeated misses, as many as the learners count", async () => {
    const failures = (prefix: string, objectiveId: string, days: readonly number[]) =>
      days.map((day, index) =>
        evidence({ id: `${prefix}${index}`, objectiveId, outcome: "failure", at: daysAgo(day) }),
      );
    await recordEvidence(database, { learnerId: ana, organizationId }, [
      // Three, the latest a day ago: flagged.
      ...failures("ag", greetings, [5, 3, 1]),
      // Three, as many as Ben's, the latest two days ago: listed after his.
      ...failures("an", numbers, [4, 3, 2]),
      // The organization's, outside the course: flags nothing here.
      ...failures("aw", weather, [3, 2, 1]),
    ]);
    await recordEvidence(database, { learnerId: ben, organizationId }, [
      // Four since a success, the latest three days ago: flagged, listed before Ana.
      evidence({ id: "bg", objectiveId: greetings, at: daysAgo(9) }),
      ...failures("bg", greetings, [6, 5, 4, 3]),
      // Three, the latest a day ago: before Ana, though her name comes first.
      ...failures("bn", numbers, [5, 4, 1]),
      // Three, then cleared by one success.
      ...failures("bc", colours, [4, 3, 2]),
      evidence({ id: "bc", objectiveId: colours, at: daysAgo(1) }),
    ]);

    const read = await overview();
    if (read.kind !== "assessed") throw new Error("No overview");
    const { learners, objectives } = read.overview;

    expect(read.overview).toMatchObject({
      asOf: now,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
    });
    expect(objectives.map(({ title, repeatedMisses }) => [title, repeatedMisses])).toEqual([
      [
        "Greetings",
        [
          {
            userId: ben,
            name: ben,
            misses: { count: 4, lastMissAt: daysAgo(3), everSucceeded: true },
          },
          {
            userId: ana,
            name: ana,
            misses: { count: 3, lastMissAt: daysAgo(1), everSucceeded: false },
          },
        ],
      ],
      [
        "Numbers",
        [
          {
            userId: ben,
            name: ben,
            misses: { count: 3, lastMissAt: daysAgo(1), everSucceeded: false },
          },
          {
            userId: ana,
            name: ana,
            misses: { count: 3, lastMissAt: daysAgo(2), everSucceeded: false },
          },
        ],
      ],
      ["Colours", []],
    ]);
    expect(learners.map(({ userId, repeatedMisses }) => [userId, repeatedMisses])).toEqual([
      [ana, 2],
      [ben, 2],
      [teacher, 0],
    ]);
    // Per objective or per learner, the same flags are counted.
    const flagged = objectives.reduce((sum, { repeatedMisses }) => sum + repeatedMisses.length, 0);
    expect(learners.reduce((sum, { repeatedMisses }) => sum + repeatedMisses, 0)).toBe(flagged);
    // And each is what that learner's report shows at the same moment.
    for (const { userId } of learners) {
      const report = await readLearnerProgress({
        database,
        viewedBy: teacher,
        accessKind: "browser",
        learnerId: userId,
        courseId: course,
        host: installation,
        now,
      });
      if (report.kind !== "assessed") throw new Error(`No report for ${userId}`);
      const reported = report.report.objectives.flatMap(({ objectiveId, phase, misses }) =>
        phase === "acquiring" && misses && misses.count >= report.report.repeatedMissesThreshold
          ? [[objectiveId, misses]]
          : [],
      );
      expect(reported).toEqual(
        objectives.flatMap(({ objectiveId, repeatedMisses }) =>
          repeatedMisses
            .filter((flag) => flag.userId === userId)
            .map(({ misses }) => [objectiveId, misses]),
        ),
      );
    }
  });

  test("says when each learner last answered here, as their report says", async () => {
    const attempt = (id: string, objectiveId: string, at: Date): Evidence =>
      evidence({ id: `${ATTEMPT_EVIDENCE_PREFIX}${id}:${objectiveId}`, objectiveId, at });
    await recordEvidence(database, { learnerId: ana, organizationId }, [
      attempt("a1", greetings, daysAgo(12)),
      attempt("a2", numbers, daysAgo(6)),
      // Outside the course, and an outside result: neither is practice here.
      attempt("a3", weather, daysAgo(1)),
      evidence({ id: "a4", objectiveId: greetings, at: daysAgo(1) }),
    ]);
    await recordEvidence(database, { learnerId: ben, organizationId }, [
      attempt("b1", colours, daysAgo(3)),
      // After the moment described.
      attempt("b2", colours, new Date(now.getTime() + 1000)),
    ]);

    const read = await overview();
    if (read.kind !== "assessed") throw new Error("No overview");
    expect(
      read.overview.learners.map(({ userId, lastPractisedAt }) => [userId, lastPractisedAt]),
    ).toEqual([
      [ana, daysAgo(6)],
      [ben, daysAgo(3)],
      [teacher, null],
    ]);
    for (const { userId, lastPractisedAt } of read.overview.learners) {
      const report = await readLearnerProgress({
        database,
        viewedBy: teacher,
        accessKind: "browser",
        learnerId: userId,
        courseId: course,
        host: installation,
        now,
      });
      expect(report).toMatchObject({ report: { lastPractisedAt } });
    }
  });

  test("lists no objectives for a course without any", async () => {
    const read = await overview({ courseId: emptyCourse });

    if (read.kind !== "assessed") throw new Error("No overview");
    expect(read.overview.objectives).toEqual([]);
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

  test("shows a tool the overview only while the organization allows it (access-45)", async () => {
    await testing.setToolsReadLearnerData(database, organizationId, false);
    expect(await overview({ accessKind: "tool" })).toEqual(
      await overview({ accessKind: "tool", courseId: "no-such-course" }),
    );
    expect(await overview({ accessKind: "tool" })).toEqual({ kind: "unavailable" });
    expect(await overview({ accessKind: "browser" })).toMatchObject({ kind: "assessed" });

    await testing.setToolsReadLearnerData(database, organizationId, true);
    expect(await overview({ accessKind: "tool" })).toEqual(
      await overview({ accessKind: "browser" }),
    );
    expect(await overview({ accessKind: "tool" })).toMatchObject({ kind: "assessed" });
    // The setting adds no reader: a member still reads no overview.
    expect(await overview({ accessKind: "tool", viewedBy: ana })).toEqual({ kind: "unavailable" });
  });
});
