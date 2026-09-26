// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, runMigrations } from "@braivo/db";
import { organizationDomain } from "@braivo/db/schema";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { drizzle } from "drizzle-orm/bun-sql";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { Evidence } from "../learning/index.ts";
import { createCourse, createObjectives, recordEvidence } from "../persistence/index.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

/**
 * A second connection that records every statement it runs. The order this
 * module promises is invisible in what it returns — a refused reader gets
 * `undefined` either way — so the statements are the only place to see it.
 */
const statements: string[] = [];
const recording: Database = drizzle({
  connection: connectionString ?? "",
  schema: authTables,
  logger: { logQuery: (query) => void statements.push(query) },
});

const organizationId = "learner-in-course-test-org";
const otherOrganizationId = "learner-in-course-test-other-org";
const learner = "learner-in-course-test-learner";
const stranger = "learner-in-course-test-stranger";
/** Registered as `otherOrganizationId`'s own domain. */
const otherHostname = "learner-in-course-test.example.com";
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

let pastTense!: string;
let fractions!: string;
let course!: string;
let foreignCourse!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: daysAgo(1), ...overrides };
}

/** Whether any recorded statement touched Better Auth's membership table. */
const askedAboutMembership = () => statements.some((statement) => statement.includes('"member"'));

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("loading a learner in a course", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      at: now,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
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
      objectiveIds: [fractions, pastTense],
    });
    await database
      .insert(organizationDomain)
      .values({ hostname: otherHostname, organizationId: otherOrganizationId })
      .onConflictDoNothing();

    const [theirs] = await createObjectives(database, otherOrganizationId, ["Theirs"]);
    foreignCourse = await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [theirs!],
    });
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [learner]);
    statements.length = 0;
  });

  afterAll(async () => {
    await recording.$client.close();
  });

  test("loads the course's objectives in content order and the learner's estimates", async () => {
    await recordEvidence(database, learner, [evidence()]);

    const loaded = await loadLearnerInCourse(database, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: () => true,
    });

    // Content order, not creation order: fractions was created second.
    expect(loaded?.objectiveIds).toEqual([fractions, pastTense]);
    expect([...(loaded?.estimates.keys() ?? [])]).toEqual([pastTense]);
  });

  test("leaves out evidence dated after the moment it loads for", async () => {
    await recordEvidence(database, learner, [evidence({ at: new Date(now.getTime() + 1000) })]);

    const loaded = await loadLearnerInCourse(database, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: () => true,
    });

    expect(loaded?.estimates.size).toBe(0);
  });

  test("loads nothing for a course that does not exist, and asks no one", async () => {
    let asked = false;

    const loaded = await loadLearnerInCourse(database, {
      courseId: "no-such-course",
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async () => (asked = true),
    });

    expect(loaded).toBeUndefined();
    expect(asked).toBe(false);
  });

  test("asks about the organization the course belongs to, and no other", async () => {
    const asked: string[] = [];

    await loadLearnerInCourse(database, {
      courseId: foreignCourse,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async (id) => (asked.push(id), false),
    });

    expect(asked).toEqual([otherOrganizationId]);
  });

  test("loads nothing on another organization's domain, before asking anyone", async () => {
    const asked: string[] = [];
    const load = (courseId: string) =>
      loadLearnerInCourse(database, {
        courseId,
        learnerId: learner,
        host: { hostname: otherHostname, installation: false },
        now,
        authorize: (id) => (asked.push(id), true),
      });

    expect(await load(course)).toBeUndefined();
    expect(asked).toEqual([]);
    // The domain's own organization's course gets as far as authorizing.
    await load(foreignCourse);
    expect(asked).toEqual([otherOrganizationId]);
  });

  test("loads nothing on a host that serves no organization", async () => {
    // Such as a domain whose row was removed: revoking it must narrow what it
    // reaches, not widen it to everything.
    const asked: string[] = [];
    const loaded = await loadLearnerInCourse(database, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "learner-in-course-test-unknown.example.com", installation: false },
      now,
      authorize: (id) => (asked.push(id), true),
    });

    expect(loaded).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("loads nothing for a learner once the reader is refused", async () => {
    const loaded = await loadLearnerInCourse(database, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async () => false,
    });

    expect(loaded).toBeUndefined();
  });

  test("loads nothing for a learner outside the course's organization", async () => {
    const loaded = await loadLearnerInCourse(database, {
      courseId: course,
      learnerId: stranger,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async () => true,
    });

    expect(loaded).toBeUndefined();
  });

  test("asks nothing about the learner once the reader is refused", async () => {
    // A refusal that still looked the learner up would take longer for a
    // member than for a stranger, and the reader could time the difference.
    // Allowed first, so the check below is known to be able to see the
    // membership query at all.
    await loadLearnerInCourse(recording, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async () => true,
    });
    expect(askedAboutMembership()).toBe(true);

    statements.length = 0;
    await loadLearnerInCourse(recording, {
      courseId: course,
      learnerId: learner,
      host: { hostname: "localhost", installation: true },
      now,
      authorize: async () => false,
    });

    expect(askedAboutMembership()).toBe(false);
  });
});
