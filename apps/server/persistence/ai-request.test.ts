// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { aiRequest } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { completeAiRequest, reserveAiRequest } from "./ai-request.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "ai-request-test-org";
const userId = "ai-request-test-teacher";
const month = new Date("2026-09-01T00:00:00.000Z");
const nextMonth = new Date("2026-10-01T00:00:00.000Z");

const record = (at: string, limit?: number) =>
  reserveAiRequest(database, {
    organizationId,
    kind: "draft",
    userId,
    at: new Date(at),
    model: "claude-sonnet-5",
    promptVersion: "0123456789ab",
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
    expect(await record("2026-08-31T23:59:59.999Z", 2)).toBeDefined();
    expect(await record("2026-08-31T23:59:59.999Z", 2)).toBeDefined();

    expect(await record("2026-09-01T00:00:00.000Z", 2)).toBeDefined();
    expect(await record("2026-09-15T12:00:00.000Z", 2)).toBeDefined();
    expect(await record("2026-09-30T23:59:59.999Z", 2)).toBeUndefined();
  });

  test("count only their own month's, whatever order they are recorded in", async () => {
    // October's, recorded first, as a request stamped in September can lag.
    expect(
      await reserveAiRequest(database, {
        organizationId,
        kind: "read",
        userId,
        at: nextMonth,
        model: "claude-sonnet-5",
        promptVersion: "0123456789ab",
        limit: { count: 1, since: nextMonth, until: new Date("2026-11-01T00:00:00.000Z") },
      }),
    ).toBeDefined();

    expect(await record("2026-09-30T23:59:59.999Z", 1)).toBeDefined();
  });

  test("are recorded without end when there is no limit", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect(await record("2026-09-02T00:00:00.000Z")).toBeDefined();
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

  test("are reserved with their model and prompt, and completed once", async () => {
    const id = await record("2026-09-04T00:00:00.000Z");
    const read = async () =>
      (await database.select().from(aiRequest).where(eq(aiRequest.id, id!)))[0];

    expect(await read()).toMatchObject({
      model: "claude-sonnet-5",
      promptVersion: "0123456789ab",
      outcome: "unknown",
      failure: null,
      counts: null,
      completedAt: null,
    });

    const at = new Date("2026-09-04T00:01:00.000Z");
    await completeAiRequest(database, id!, { outcome: "failed", failure: "timeout", at });
    // A second completion, such as one racing it, changes nothing.
    await completeAiRequest(database, id!, { outcome: "succeeded", counts: { pages: 1 }, at });

    expect(await read()).toMatchObject({
      outcome: "failed",
      failure: "timeout",
      counts: null,
      completedAt: at,
    });
  });
});
