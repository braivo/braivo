// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit only ever generates here. Migrations are applied by
 * `braivo db migrate`, and `push` is not part of the workflow, so this config
 * needs no database credentials ([ADR 0005](../../docs/adr/0005-postgresql-drizzle.md)).
 */
export default defineConfig({
  dialect: "postgresql",
  // Generated tables and hand-written ones stay in separate files; the Better
  // Auth CLI overwrites its own.
  schema: "./schema/index.ts",
  out: "./migrations",
  // Named explicitly so Braivo's migration history cannot collide with that of
  // another Drizzle application sharing the database.
  migrations: { table: "__braivo_migrations", schema: "drizzle" },
});
