#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createDatabase, runMigrations } from "@braivo/db";

import { createApi } from "../api/index.ts";
import { createAuth } from "../auth/index.ts";
import { readDatabaseUrl, readServeConfig } from "./config.ts";

const USAGE = `Usage: braivo <command>

Commands:
  db migrate    Apply committed database migrations.
  serve         Serve the HTTP API.
`;

/**
 * The process entry point is the one place that reads the environment, so the
 * modules below it take their dependencies as arguments and stay testable. What
 * those values are allowed to be lives in `config.ts`, which is testable too.
 */
async function main(argv: readonly string[]): Promise<number> {
  // Matched whole rather than by prefix. With two commands and no flags, a
  // trailing word is a typo or an option this does not have, and serving anyway
  // would answer `serve --port 4000` by listening on a different port.
  if (argv.length === 2 && argv[0] === "db" && argv[1] === "migrate") {
    await runMigrations(readDatabaseUrl(process.env));
    console.log("Migrations applied.");
    return 0;
  }

  if (argv.length === 1 && argv[0] === "serve") {
    const config = readServeConfig(process.env);
    const database = createDatabase(config.databaseUrl);
    const api = createApi({
      database,
      baseUrl: config.baseUrl,
      auth: createAuth({ database, secret: config.secret, baseURL: config.baseUrl }),
    });

    const server = Bun.serve({ port: config.port, fetch: api.fetch });
    console.log(`Braivo listening on ${server.url.href}`);

    // Returning does not end the process: the listening socket keeps it alive.
    return 0;
  }

  // Asked for, so it goes to stdout and succeeds; anything else is a command
  // that does not exist, so it goes to stderr and fails.
  if (argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
