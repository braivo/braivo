// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

import { createDatabase } from "./database.ts";

/**
 * Where Braivo records the migrations it applied, named explicitly so its
 * history cannot collide with another Drizzle application's in the database.
 */
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__braivo_migrations";

/**
 * Applies every committed migration that has not run yet. This is the only way
 * Braivo-owned schema changes ([ADR 0005](../../docs/adr/0005-postgresql-drizzle.md));
 * `drizzle-kit push` is not part of the workflow.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const migrationsFolder = committedMigrations();
  const database = createDatabase(connectionString);
  // The pool is this function's alone, so it closes here whether or not the
  // migrations applied; a caller catching the error could not close it.
  try {
    await migrate(database, {
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
    });
  } finally {
    await database.$client.end();
  }
}

/** How a database's applied migrations compare with the committed ones, by name. */
export type MigrationState = {
  /** Committed and not yet applied, which `runMigrations` would apply. */
  pending: string[];
  /**
   * Applied but not committed, or committed with other SQL: a history this
   * checkout cannot continue, as after migrations are regenerated (ADR 0005).
   */
  diverged: string[];
};

/**
 * Compares without changing anything, matching what Drizzle's migrator
 * records: each migration's folder name and the SHA-256 of its SQL.
 */
export async function readMigrationState(connectionString: string): Promise<MigrationState> {
  const committed = readMigrationFiles({ migrationsFolder: committedMigrations() });
  const client = new Client(connectionString);
  try {
    await client.connect();
    const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
    const { rows: exists } = await client.query<{ found: boolean }>(
      "select to_regclass($1) is not null as found",
      [table],
    );
    const applied = exists[0]?.found
      ? (
          await client.query<{ name: string | null; hash: string }>(
            `select name, hash from ${table}`,
          )
        ).rows
      : [];
    const hashes = new Map(committed.map(({ name, hash }) => [name, hash]));
    const names = new Set(applied.map(({ name }) => name));
    return {
      pending: committed.filter(({ name }) => !names.has(name)).map(({ name }) => name!),
      diverged: applied
        .filter(({ name, hash }) => name === null || hashes.get(name) !== hash)
        .map(({ name, hash }) => name ?? hash),
    };
  } finally {
    await client.end();
  }
}

/**
 * From this module's location, never the working directory, so `db migrate`
 * applies the migrations it shipped with rather than whatever sits beside the
 * operator's shell. On call, not import: a Worker bundling this package has no
 * module URL to resolve against.
 */
function committedMigrations(): string {
  return fileURLToPath(new URL("./migrations", import.meta.url));
}
