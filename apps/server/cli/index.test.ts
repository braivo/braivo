// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

/** The operator's command, run as from a clone; the arguments are refused before anything connects. */
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { stderr, code };
}

describe("the server's commands", () => {
  test("ask for the hostname of a learn domain left out", async () => {
    const { stderr, code } = await run(["organization", "add-domain", "--slug", "acme"]);

    expect(code).toBe(1);
    expect(stderr).toContain("organization add-domain --slug <slug> --hostname <hostname>");
  });

  test("ask for the email of a member left out", async () => {
    const { stderr, code } = await run(["organization", "add-member", "--slug", "acme"]);

    expect(code).toBe(1);
    expect(stderr).toContain("organization add-member --slug <slug> --email <email>");
  });
});
