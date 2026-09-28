// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  writeFileSync(join(main, ".gitignore"), ".env\nprivate/\n/local\n");
  writeFileSync(
    join(main, ".worktreeinclude"),
    "# comment\n\n.env\n/private/notes.md\nmissing\nunignored\n",
  );
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(main, ".env"), "SECRET=1\n");
  mkdirSync(join(main, "private"));
  writeFileSync(join(main, "private/notes.md"), "notes\n");
  writeFileSync(join(main, "unignored"), "untracked, not ignored\n");
  git(main, "worktree", "add", "-q", "--detach", linked);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("worktree setup", () => {
  test("copies the listed files that exist and are ignored, and installs dependencies", () => {
    expect(setUpWorktree(linked, install)).toEqual([
      "copied .env",
      "copied private/notes.md",
      "linked local/",
      "created tmp/",
      "installed dependencies",
    ]);
    expect(readFileSync(join(linked, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(linked, "private/notes.md"), "utf8")).toBe("notes\n");
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

  test("links one notes directory, so a note made or deleted anywhere is for all", () => {
    mkdirSync(join(main, "local/plans"), { recursive: true });
    writeFileSync(join(main, "local/plans/old.md"), "old\n");
    setUpWorktree(linked, install);

    expect(lstatSync(join(linked, "local")).isSymbolicLink()).toBe(true);
    writeFileSync(join(linked, "local/plans/new.md"), "made in the worktree\n");
    expect(readFileSync(join(main, "local/plans/new.md"), "utf8")).toBe("made in the worktree\n");
    rmSync(join(main, "local/plans/old.md"));
    expect(existsSync(join(linked, "local/plans/old.md"))).toBe(false);
    expect(setUpWorktree(linked, install)).toEqual(["installed dependencies"]);
  });

  test.each([
    ["a directory of its own", () => mkdirSync(join(linked, "local")), false],
    ["a dangling link", () => symlinkSync(join(dir, "gone"), join(linked, "local")), true],
  ])("keeps %s in place of the notes link, but fails once set up", (_, make, isLink) => {
    make();
    expect(() => setUpWorktree(linked, install)).toThrow("local/ is not a link to");
    expect(lstatSync(join(linked, "local")).isSymbolicLink()).toBe(isLink);
    expect(installs).toEqual([linked]);
  });

  test("fails once set up when the notes directory is not ignored", () => {
    writeFileSync(join(linked, ".gitignore"), ".env\nprivate/\n");
    expect(() => setUpWorktree(linked, install)).toThrow("/local is not gitignored");
    expect(existsSync(join(linked, "local"))).toBe(false);
    expect(installs).toEqual([linked]);
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
