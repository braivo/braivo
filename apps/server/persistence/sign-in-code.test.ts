// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { verification } from "@braivo/db/schema/auth";
import { sharedDatabase } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { claimSignInCode } from "./sign-in-code.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const email = "sign-in-code-test@example.com";
const at = new Date("2026-01-01T00:00:00.000Z");
const claim = (seconds: number) =>
  claimSignInCode(database, { email, at: new Date(at.getTime() + seconds * 1000), seconds: 60 });

/** Requires TEST_DATABASE_URL, since the point is one statement deciding under concurrency. */
describe.skipIf(!connectionString)("claiming a sign-in code for an address", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await database.delete(verification).where(eq(verification.id, `sign-in-code-sent:${email}`));
  });

  test("succeeds once a minute, the minute counted from the last claim that succeeded", async () => {
    expect(await claim(0)).toBe(true);
    expect(await claim(59)).toBe(false);
    expect(await claim(60)).toBe(true);
    // A refusal does not move the minute on: 60 + 60 is free again.
    expect(await claim(119)).toBe(false);
    expect(await claim(120)).toBe(true);
  });

  test("goes to one of several asking at once", async () => {
    const claims = await Promise.all(Array.from({ length: 5 }, () => claim(0)));

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
