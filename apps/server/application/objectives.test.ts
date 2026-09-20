// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as authTables from "@braivo/db/schema/auth";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { defineObjectives, listObjectives } from "./objectives.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "objectives-test-org";
const otherOrganizationId = "objectives-test-other-org";
/** An admin, and so someone who may author for the organization. */
const author = "objectives-test-author";
/** A member, and so someone who may only study in it. */
const learner = "objectives-test-learner";
/** A real user who belongs to no organization at all. */
const outsider = "objectives-test-outsider";
const at = new Date("2026-01-01T00:00:00.000Z");

function define(titles: readonly string[], actingAs = author, organization = organizationId) {
  return defineObjectives({ database, organizationId: organization, actingAs, titles });
}

function list(actingAs = author, organization = organizationId) {
  return listObjectives({ database, organizationId: organization, actingAs });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("defining objectives", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await database
      .insert(authTables.user)
      .values({
        id: outsider,
        name: outsider,
        email: `${outsider}@example.com`,
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
      adminIds: [],
      at,
    });
  });

  test("returns generated IDs and lists them back by title", async () => {
    const [zulu, alpha] = await define(["Zulu", "Alpha"]);

    expect(await list()).toEqual([
      { id: alpha!, title: "Alpha" },
      { id: zulu!, title: "Zulu" },
    ]);
  });

  test("refuses a learner who may only study", async () => {
    // Authoring is a content owner's act, and a learner is a `member`.
    await expect(define(["Snuck in"], learner)).rejects.toBeInstanceOf(NotPermitted);

    expect(await list()).toEqual([]);
  });

  test("refuses someone from outside the organization", async () => {
    await expect(define(["Theirs"], outsider)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("refuses an admin of one organization acting on another", async () => {
    // The role is checked against the organization named, not merely held.
    await expect(define(["Elsewhere"], author, otherOrganizationId)).rejects.toBeInstanceOf(
      NotPermitted,
    );
  });

  test("refuses to list for anyone who may not administer", async () => {
    await define(["Alpha"]);

    await expect(list(learner)).rejects.toBeInstanceOf(NotPermitted);
    await expect(list(outsider)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("keeps each organization's objectives to itself", async () => {
    await define(["Ours"]);

    expect(await list()).toMatchObject([{ title: "Ours" }]);
    expect(await list(author, otherOrganizationId).catch(() => "refused")).toBe("refused");
  });

  test("defines nothing, and does not fail, for an empty list", async () => {
    expect(await define([])).toEqual([]);
    expect(await list()).toEqual([]);
  });
});
