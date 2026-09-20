// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/bun-sql/migrator";

import { createDatabase } from "./database.ts";

/**
 * Resolved from this module's location, never from the working directory, so
 * `braivo db migrate` applies the migrations it shipped with rather than
 * whatever happens to sit beside the operator's shell.
 */
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Applies every committed migration that has not run yet. This is the only way
 * Braivo-owned schema changes ([ADR 0005](../../docs/adr/0005-postgresql-drizzle.md));
 * `drizzle-kit push` is not part of the workflow.
 *
 * The bookkeeping table is named explicitly so Braivo's history cannot collide
 * with that of another Drizzle application sharing the database.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const database = createDatabase(connectionString);
  // The pool is this function's alone, so it closes here whether or not the
  // migrations applied; a caller catching the error could not close it.
  try {
    await migrate(database, {
      migrationsFolder,
      migrationsTable: "__braivo_migrations",
      migrationsSchema: "drizzle",
    });
  } finally {
    await database.$client.end();
  }
}
