// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { setUpWorktree } from "./worktree-setup.ts";

let dir: string;
let main: string;
let linked: string;
let installs: string[];

const install = (root: string) => void installs.push(root);

/** Hooks off: this exercises the script, not whichever hooks the machine has. */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });
}

beforeEach(() => {
  // Real path: Git reports one, and macOS's temp directory is behind a symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-")));
  main = join(dir, "main");
  linked = join(dir, "linked");
  installs = [];
  mkdirSync(main);
  git(main, "init", "-q");
  writeFileSync(join(main, ".gitignore"), ".env\nlocal/\n");
  writeFileSync(
    join(main, ".worktreeinclude"),
    "# comment\n\n.env\n/local/notes.md\nmissing\nunignored\n",
  );
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(main, ".env"), "SECRET=1\n");
  mkdirSync(join(main, "local"));
  writeFileSync(join(main, "local/notes.md"), "notes\n");
  writeFileSync(join(main, "unignored"), "untracked, not ignored\n");
  git(main, "worktree", "add", "-q", "--detach", linked);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("worktree setup", () => {
  test("copies the listed files that exist and are ignored, and installs dependencies", () => {
    expect(setUpWorktree(linked, install)).toEqual([
      "copied .env",
      "copied local/notes.md",
      "created tmp/",
      "installed dependencies",
    ]);
    expect(readFileSync(join(linked, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(linked, "local/notes.md"), "utf8")).toBe("notes\n");
    expect(existsSync(join(linked, "missing"))).toBe(false);
    expect(existsSync(join(linked, "unignored"))).toBe(false);
    expect(existsSync(join(linked, "tmp"))).toBe(true);
    expect(installs).toEqual([linked]);
  });

  test("works from a subdirectory of the worktree", () => {
    mkdirSync(join(linked, "sub"));
    setUpWorktree(join(linked, "sub"), install);
    expect(existsSync(join(linked, ".env"))).toBe(true);
    expect(installs).toEqual([linked]);
  });

  test("never overwrites copied files and installs on every run", () => {
    setUpWorktree(linked, install);
    writeFileSync(join(linked, ".env"), "EDITED=1\n");
    expect(setUpWorktree(linked, install)).toEqual(["installed dependencies"]);
    expect(readFileSync(join(linked, ".env"), "utf8")).toBe("EDITED=1\n");
    expect(installs).toEqual([linked, linked]);
  });

  test("does nothing in the main checkout", () => {
    expect(setUpWorktree(main, install)).toEqual([]);
    expect(installs).toEqual([]);
  });

  test.each(["*.env", "!.env", "../outside", "/etc/../../secret"])(
    "refuses %s in .worktreeinclude",
    (line) => {
      writeFileSync(join(linked, ".worktreeinclude"), `${line}\n`);
      expect(() => setUpWorktree(linked, install)).toThrow("expected a literal path");
    },
  );
});
