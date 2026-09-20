// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { drizzle } from "drizzle-orm/bun-sql";

import * as authSchema from "./schema/auth.ts";

/**
 * Bun's built-in SQL client, so PostgreSQL access costs no driver dependency:
 * Braivo runs on Bun everywhere, so a portable driver would buy nothing.
 *
 * The connection string is an argument rather than an environment read, so that
 * tests and the CLI open their own databases without a module-level singleton
 * deciding for them.
 */
export function createDatabase(connectionString: string) {
  return drizzle({ connection: connectionString, schema: authSchema });
}

export type Database = ReturnType<typeof createDatabase>;
