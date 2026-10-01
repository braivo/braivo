// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { recordAiRequest } from "./ai-request.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "ai-request-test-org";
const userId = "ai-request-test-teacher";
const month = new Date("2026-09-01T00:00:00.000Z");
const nextMonth = new Date("2026-10-01T00:00:00.000Z");

const record = (at: string, limit?: number) =>
  recordAiRequest(database, {
    organizationId,
    kind: "draft",
    userId,
    at: new Date(at),
    ...(limit === undefined ? {} : { limit: { count: limit, since: month, until: nextMonth } }),
  });

/** Requires TEST_DATABASE_URL, since the point is what the database counts. */
describe.skipIf(!connectionString)("an organization's AI requests", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [userId],
      at: month,
    });
  });

  test("are recorded up to the limit since the month began, and no further", async () => {
    // Last month's do not count against this one.
    expect(await record("2026-08-31T23:59:59.999Z", 2)).toBe(true);
    expect(await record("2026-08-31T23:59:59.999Z", 2)).toBe(true);

    expect(await record("2026-09-01T00:00:00.000Z", 2)).toBe(true);
    expect(await record("2026-09-15T12:00:00.000Z", 2)).toBe(true);
    expect(await record("2026-09-30T23:59:59.999Z", 2)).toBe(false);
  });

  test("count only their own month's, whatever order they are recorded in", async () => {
    // October's, recorded first, as a request stamped in September can lag.
    expect(
      await recordAiRequest(database, {
        organizationId,
        kind: "read",
        userId,
        at: nextMonth,
        limit: { count: 1, since: nextMonth, until: new Date("2026-11-01T00:00:00.000Z") },
      }),
    ).toBe(true);

    expect(await record("2026-09-30T23:59:59.999Z", 1)).toBe(true);
  });

  test("are recorded without end when there is no limit", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect(await record("2026-09-02T00:00:00.000Z")).toBe(true);
    }
  });

  test("give the last one to only one of two racing requests", async () => {
    await record("2026-09-02T00:00:00.000Z", 3);
    await record("2026-09-02T00:00:00.000Z", 3);

    const raced = await Promise.all([
      record("2026-09-03T00:00:00.000Z", 3),
      record("2026-09-03T00:00:00.000Z", 3),
    ]);

    expect(raced.filter((recorded) => recorded)).toHaveLength(1);
  });
});
