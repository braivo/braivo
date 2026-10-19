// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vite-plus/test";

// The standalone `braivo` is this entry point bundled (docs/adr/0027-standalone-cli.md).
// Bundling can reorder module initialization and crash every command before it
// runs, so the bundle itself is what runs here. `--compile` adds only the
// runtime, and is left to the release workflow.

let directory!: string;
let bundle!: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "braivo-build-"));
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    target: "bun",
    outdir: directory,
    // As the release workflow passes it.
    define: { BRAIVO_VERSION: JSON.stringify("1.2.3") },
  });
  if (!built.success) throw new AggregateError(built.logs, "The CLI did not bundle.");
  bundle = built.outputs[0]!.path;
}, 60_000);

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, bundle, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the bundled CLI", () => {
  test("starts, and says what it does", async () => {
    const { stdout, code } = await run([]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: braivo <command>");
  });

  test("says which release it is", async () => {
    const { stdout, code } = await run(["--version"]);

    expect(code).toBe(0);
    expect(stdout).toBe("braivo 1.2.3\n");
  });
});
