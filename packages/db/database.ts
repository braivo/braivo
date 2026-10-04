// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { authRelations } from "./schema/auth.ts";

/**
 * node-postgres, the driver both Bun and Cloudflare Workers (through
 * Hyperdrive) run, so the server is not tied to Bun's own client
 * ([ADR 0034](../../docs/adr/0034-node-postgres.md)).
 *
 * The connection string is an argument rather than an environment read, so that
 * tests, the CLI, and a Worker's per-request Hyperdrive binding each open their
 * own database without a module-level singleton deciding for them. The pool
 * opens connections only when a query needs one.
 */
export function createDatabase(connectionString: string) {
  // pg waits forever on a server that accepts the connection and never
  // answers; Bun's client gave up after 30 seconds, and so does this.
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 30_000 });
  // A dropped idle connection, PostgreSQL restarting or the network cut, is
  // reported here rather than to a query, and with no listener it ends the
  // process; the pool discards that connection and opens another when needed.
  // Ignored once the pool is ending: Workers report its own closing this way.
  pool.on("error", (error) => {
    if (!pool.ending) console.error("A database connection was lost:", error.message);
  });
  return drizzle({ client: pool, relations: authRelations });
}

export type Database = ReturnType<typeof createDatabase>;
