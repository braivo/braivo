// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bootstraps a linked worktree for development, whichever tool created it:
 * copies the local files `.worktreeinclude` lists from the main checkout,
 * creates `tmp/`, then installs dependencies. Safe to rerun, and a no-op in
 * the main checkout (docs/adr/0014-worktree-setup.md). Bun and Git only: it
 * runs before `node_modules` exists.
 *
 *   bun tooling/worktree-setup.ts
 */

import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

export type Install = (root: string) => void;

/**
 * Output goes to stderr: a Claude Code hook's stdout becomes the agent's
 * context, which should get the one-line summary, not Bun's progress.
 */
const bunInstall: Install = (root) => {
  execFileSync(process.execPath, ["install", "--frozen-lockfile"], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
};

/**
 * Sets up the worktree containing `cwd` and returns what it did, empty in the
 * main checkout.
 */
export function setUpWorktree(cwd: string, install: Install = bunInstall): string[] {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  // Git lists the main worktree first; -z keeps any path intact.
  const main = git(cwd, "worktree", "list", "--porcelain", "-z")
    .split("\0")[0]!
    .slice("worktree ".length);
  if (realpathSync(root) === realpathSync(main)) return [];

  const done: string[] = [];
  for (const path of includedPaths(root)) {
    const source = join(main, path);
    if (!existsSync(source) || !isIgnored(root, path)) continue;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      // Never overwrite: the creating tool may have copied it, or someone edited it.
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      done.push(`copied ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  // Gitignored scratch space agents and review skills write to (tmp/feedback.md).
  if (mkdirSync(join(root, "tmp"), { recursive: true })) done.push("created tmp/");

  // Always: a failed install leaves `node_modules` behind, and a complete one
  // makes this a 0.3 s no-op.
  install(root);
  done.push("installed dependencies");
  return done;
}

/**
 * Claude Code reads `.worktreeinclude` as `.gitignore` patterns and copies
 * only matches that are gitignored. This accepts only literal paths from the
 * repository root, which mean the same to both, and refuses anything else
 * rather than copy different files.
 */
function includedPaths(root: string): string[] {
  const file = join(root, ".worktreeinclude");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const path = normalize(line.replace(/^\//, ""));
      if (/[*?[\]!\\]/.test(line) || isAbsolute(path) || path.startsWith("..")) {
        throw new Error(
          `.worktreeinclude: expected a literal path in the repository, got "${line}"`,
        );
      }
      return path;
    });
}

/** Against the worktree's own ignore rules, as Claude Code checks. */
function isIgnored(root: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

if (import.meta.main) {
  const done = setUpWorktree(process.cwd());
  if (done.length > 0) console.log(`Worktree set up: ${done.join(", ")}.`);
}
