// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { mayReadLearnerData } from "./access.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const allowing = "access-test-allowing-org";
const refusing = "access-test-refusing-org";
const at = new Date("2026-06-01T00:00:00.000Z");

const may = (organizationId: string, accessKind: "browser" | "tool") =>
  mayReadLearnerData(database, { organizationId, accessKind });

/** Requires TEST_DATABASE_URL: the setting is read from the database. */
describe.skipIf(!connectionString)("whether a request may read learners' data", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    for (const organizationId of [allowing, refusing]) {
      await testing.seedOrganization(database, { organizationId, learnerIds: [], at });
    }
    await testing.setToolsReadLearnerData(database, allowing, true);
  });

  test("refuses a tool by default, and admits a browser", async () => {
    expect(await may(refusing, "tool")).toBe(false);
    expect(await may(refusing, "browser")).toBe(true);
  });

  test("admits a tool where the organization allows it, and only there", async () => {
    expect(await may(allowing, "tool")).toBe(true);
    expect(await may(refusing, "tool")).toBe(false);
  });

  test("reads the setting on every call, so switching it off refuses the next", async () => {
    expect(await may(allowing, "tool")).toBe(true);
    await testing.setToolsReadLearnerData(database, allowing, false);
    expect(await may(allowing, "tool")).toBe(false);
    expect(await may(allowing, "browser")).toBe(true);
  });

  test("refuses a tool for an organization that does not exist", async () => {
    expect(await may("access-test-missing-org", "tool")).toBe(false);
  });
});
