// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gives each linked worktree a test database of its own: `TEST_DATABASE_URL`'s
 * database suffixed with Git's id for the worktree, created on first use. The
 * main checkout uses the configured one (docs/adr/0014-worktree-setup.md).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Client } from "pg";

import { withoutRepositoryVariables } from "./git-env.ts";

/** PostgreSQL's identifier limit, in bytes; longer names are silently cut. */
const MAX_NAME = 63;
/**
 * Hex characters of the hash ending a name cut to fit. It separates only ids
 * sharing the readable part, rarely more than a few: 8 makes a collision among
 * them negligible, and more would only cost readable characters.
 */
const HASH_LENGTH = 8;

export default async function testDatabase(): Promise<void> {
  const configured = process.env.TEST_DATABASE_URL;
  if (!configured) return;
  const worktree = linkedWorktree(import.meta.dirname);
  if (!worktree) return;
  const { url, name } = worktreeDatabase(configured, worktree);
  await createDatabase(configured, name);
  // Test files run in workers started after this, which inherit it.
  process.env.TEST_DATABASE_URL = url;
}

/**
 * The worktree's database name, decoded as PostgreSQL receives it, and the
 * configured URL naming it instead.
 */
export function worktreeDatabase(
  configured: string,
  worktree: string,
): { url: string; name: string } {
  const url = new URL(configured);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error("TEST_DATABASE_URL names no database.");
  const name = fitName(database, worktree);
  url.pathname = `/${encodeURIComponent(name)}`;
  return { url: url.href, name };
}

/**
 * `<database>_<worktree>`, verbatim while it fits: Git keeps ids unique, and a
 * quoted identifier keeps them apart. Past the limit, which folders named after
 * long branches reach, the id is cut on a character boundary and the name ends
 * in `_` and a hash of the whole name, so ids differing past the cut are unlikely
 * to collide.
 */
function fitName(database: string, worktree: string): string {
  const name = `${database}_${worktree}`;
  if (Buffer.byteLength(name) <= MAX_NAME) return name;
  const suffix = `_${createHash("sha256").update(name).digest("hex").slice(0, HASH_LENGTH)}`;
  const room = MAX_NAME - suffix.length;
  const base = `${database}_`;
  let prefix = base;
  for (const character of worktree) {
    if (Buffer.byteLength(prefix + character) > room) break;
    prefix += character;
  }
  if (prefix === base) {
    throw new Error(
      `Shorten TEST_DATABASE_URL's database name: "${database}" leaves no room for the worktree's id within PostgreSQL's ${MAX_NAME}-byte limit.`,
    );
  }
  return prefix + suffix;
}

/** Git's name for the linked worktree holding `cwd`; undefined in the main checkout. */
function linkedWorktree(cwd: string): string | undefined {
  const [gitDir, commonDir] = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { cwd, encoding: "utf8", env: withoutRepositoryVariables() },
  )
    .trim()
    .split("\n");
  return gitDir === commonDir ? undefined : basename(gitDir!);
}

/**
 * Creates it through the configured database, which needs `CREATEDB`. A
 * concurrent run may create it first, raising any error here: the recheck tells.
 */
async function createDatabase(configured: string, name: string): Promise<void> {
  const client = new Client(configured);
  const exists = async () =>
    (await client.query("select 1 from pg_database where datname = $1", [name])).rowCount! > 0;
  await client.connect();
  try {
    if (await exists()) return;
    await client.query(`create database "${name.replaceAll('"', '""')}"`);
  } catch (error) {
    if (!(await exists())) {
      throw new Error(`Could not create this worktree's test database "${name}".`, {
        cause: error,
      });
    }
  } finally {
    await client.end();
  }
}
