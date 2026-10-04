// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase } from "./database.ts";

/**
 * Applies every committed migration that has not run yet. This is the only way
 * Braivo-owned schema changes ([ADR 0005](../../docs/adr/0005-postgresql-drizzle.md));
 * `drizzle-kit push` is not part of the workflow.
 *
 * The bookkeeping table is named explicitly so Braivo's history cannot collide
 * with that of another Drizzle application sharing the database.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  // From this module's location, never the working directory, so `braivo db
  // migrate` applies the migrations it shipped with rather than whatever sits
  // beside the operator's shell. On call, not import: a Worker bundling this
  // package has no module URL to resolve against.
  const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
  // The standalone `braivo` is built for content owners and carries no
  // migrations (docs/adr/0027-standalone-cli.md); say so, not "no such folder".
  if (!existsSync(migrationsFolder)) {
    throw new Error(
      "This braivo has no migrations to apply. Run `braivo db migrate` from Braivo's source or container image.",
    );
  }
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
