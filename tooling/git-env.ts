// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";

/** Git's own list of the environment variables local to a repository. */
let repositoryVariables: string[] | undefined;

/**
 * A copy of the environment without them. Git exports `GIT_DIR` and others to
 * hooks and `git rebase --exec`; inherited, they point a child's Git at that
 * repository instead of the one its directory holds.
 */
export function withoutRepositoryVariables(): NodeJS.ProcessEnv {
  repositoryVariables ??= execFileSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const env = { ...process.env };
  for (const name of repositoryVariables) delete env[name];
  return env;
}
