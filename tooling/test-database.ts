// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gives each linked worktree a test database of its own: `TEST_DATABASE_URL`'s
 * database suffixed with Git's id for the worktree, created on first use. The
 * main checkout uses the configured one (docs/adr/0014-worktree-setup.md).
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { Client } from "pg";

/** PostgreSQL's identifier limit, in bytes; longer names are silently cut. */
const MAX_NAME = 63;

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
  // Verbatim: Git keeps ids unique, and a quoted identifier keeps them apart.
  const name = `${database}_${worktree}`;
  if (Buffer.byteLength(name) > MAX_NAME) {
    throw new Error(`Test database name "${name}" is longer than ${MAX_NAME} bytes.`);
  }
  url.pathname = `/${encodeURIComponent(name)}`;
  return { url: url.href, name };
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
 * Without the variables naming another repository (`git rebase --exec` exports
 * `GIT_DIR`), keeping the rest, such as `GIT_CONFIG_*`.
 */
function withoutRepositoryVariables(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  return env;
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
