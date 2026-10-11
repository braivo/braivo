// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase, runMigrations } from "@braivo/db";

import { baseUrl } from "./api/testing.ts";
import { createAuth } from "./auth/index.ts";

/**
 * Migrates the test database and seeds `mcp()`'s OAuth resource before any
 * test file loads. A file builds `createAuth` on import, which seeds it: on a
 * fresh database that finds no table, or races another instance to the row.
 * Better Auth tolerates both only by the error's message, which Drizzle wraps,
 * so the instance would start broken.
 */
export default async function prepareTestDatabase(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
  const database = createDatabase(url);
  try {
    // `createTestApi`'s base URL, so its instances find the resource seeded.
    await createAuth({
      database,
      secret: "prepare-test-database-secret-long-enough",
      baseURL: baseUrl,
      sendMail: async () => {},
    }).$context;
  } finally {
    await database.$client.end();
  }
}
