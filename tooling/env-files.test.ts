// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

import { describe, expect, test } from "vite-plus/test";

import { withoutRepositoryVariables } from "./git-env.ts";

// docs/adr/0051-environment-files.md
const root = join(import.meta.dirname, "..");

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutRepositoryVariables(),
  });
}

/** `bun run <script>` with nothing of this shell's but what finds Bun, this one first. */
function run(script: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["run", "--silent", ...script], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: process.env.HOME,
      ...env,
    },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("env files", () => {
  test("only the development defaults are committed", () => {
    expect(git("ls-files", "--", ":(glob)**/.env*").split("\n")).toEqual([".env.development", ""]);
  });

  test("every other env file is ignored, at any depth", () => {
    // `--no-index`: the rules alone, as a file already tracked is never reported.
    const paths = [".env", ".env.local", ".env.development.local", "apps/server/.env.development"];
    expect(git("check-ignore", "--no-index", ...paths).split("\n")).toEqual([...paths, ""]);
    const committed = spawnSync("git", ["check-ignore", "--no-index", "-q", ".env.development"], {
      cwd: root,
      env: withoutRepositoryVariables(),
    });
    expect(committed.status).toBe(1);
  });

  test("the development defaults assign no secret, not even in a comment", () => {
    const text = readFileSync(join(root, ".env.development"), "utf8");
    const secret = /SECRET|KEY|TOKEN|PASSWORD/;
    const defaults = Object.entries(parseEnv(text));
    expect(defaults.length).toBeGreaterThan(0);
    for (const [name, value] of defaults) {
      expect(name).not.toMatch(secret);
      if (URL.canParse(value!)) expect(new URL(value!).password, name).toBe("");
    }
    // The optional settings are listed in comments, prose after a space: a value
    // written right after `=` is as committed as a default.
    for (const [, name, value] of text.matchAll(/\b([A-Z][A-Z0-9_]*)=(\S*)/g)) {
      if (secret.test(name!)) expect(value, name).toBe("");
    }
  });

  test("scripts name the files they load, so NODE_ENV cannot change which", () => {
    const scripts = (path: string) =>
      (JSON.parse(readFileSync(join(root, path), "utf8")) as { scripts: Record<string, string> })
        .scripts;
    const files = (script: string) =>
      [...script.matchAll(/--env-file=(?:\.\.\/\.\.\/)?(\S+)/g)].map((m) => m[1]);
    const server = scripts("apps/server/package.json");
    // Each over the one before, as Bun's own loading ranks them.
    const development = [".env.development", ".env.local", ".env.development.local"];
    expect(files(server.dev!), "dev").toEqual(development);
    expect(files(server.check!), "check").toEqual(development);
    expect(files(scripts("package.json").test!), "test").toEqual([".env.local"]);
  });

  test("serve loads none, so a missing setting is refused rather than defaulted", () => {
    // Were files loaded, DATABASE_URL would be set and this invalid URL, which
    // they cannot override, would stop the server instead, never serving.
    const { status, output } = run(["serve"], { BRAIVO_URL: "not a url" });
    expect(output).toContain("DATABASE_URL");
    expect(status).not.toBe(0);
  });
});
