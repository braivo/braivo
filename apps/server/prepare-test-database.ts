// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";

/** Migrates the test database before any test file loads. */
export default async function prepareTestDatabase(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
}
