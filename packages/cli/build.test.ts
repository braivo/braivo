// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { saveCredentials } from "./credentials.ts";

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

async function run(args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, bundle, ...args], {
    env: { PATH: process.env.PATH ?? "", ...environment },
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

  test("serves its tools to a desktop agent", async () => {
    const home = join(directory, "config");
    await saveCredentials(join(home, "braivo", "credentials.json"), {
      server: "http://localhost:3000",
      token: "unused: listing tools asks nothing of the server",
    });
    const agent = new Client({ name: "test", version: "0" });

    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle, "mcp"],
        env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: home },
      }),
    );
    try {
      const { tools } = await agent.listTools();
      expect(tools.map((tool) => tool.name)).toContain("add_document");
      expect(agent.getServerVersion()?.version).toBe("1.2.3");
    } finally {
      await agent.close();
    }
  });
});
