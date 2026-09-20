// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { clearLearningData, seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createCourse } from "./course.ts";
import { createObjectives } from "./objective.ts";
import { organizationOwnsLearningContent } from "./organization.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "organization-test-org";
const otherOrganizationId = "organization-test-other-org";
const at = new Date("2026-01-01T00:00:00.000Z");

const owns = (id: string = organizationId) => organizationOwnsLearningContent(database, id);

/** Requires TEST_DATABASE_URL, since the point is which rows the database holds. */
describe.skipIf(!connectionString)("what an organization still owns", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await seedOrganization(database, { organizationId, learnerIds: [], at });
    await seedOrganization(database, { organizationId: otherOrganizationId, learnerIds: [], at });
  });

  test("owns nothing when it has no objectives and no courses", async () => {
    expect(await owns()).toBe(false);
  });

  test("owns something once an objective exists", async () => {
    await createObjectives(database, organizationId, ["Past tense"]);

    expect(await owns()).toBe(true);
  });

  test("owns something once a course exists, even with no objectives in it", async () => {
    // A course restricts the organization delete on its own, so checking only
    // objectives would report nothing to lose and leave the delete to fail on a
    // constraint — the outcome the check exists to replace.
    await createCourse(database, { organizationId, title: "Empty", objectiveIds: [] });

    expect(await owns()).toBe(true);
  });

  test("does not count another organization's content", async () => {
    await createObjectives(database, otherOrganizationId, ["Theirs"]);
    await createCourse(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      objectiveIds: [],
    });

    expect(await owns()).toBe(false);
    expect(await owns(otherOrganizationId)).toBe(true);
  });

  test("owns nothing again once its content is gone", async () => {
    await createObjectives(database, organizationId, ["Past tense"]);
    await clearLearningData(database, organizationId);

    expect(await owns()).toBe(false);
  });
});
