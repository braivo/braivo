// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createAuth } from "../auth/index.ts";
import { type Api, createApi } from "./index.ts";

/**
 * Runs the walkthrough in the repository README against a real server, exactly
 * as written there — the one document here that can be made to fail rather than
 * drifting silently, and the only test that exercises a socket, a cookie jar,
 * and the commands a person would actually type.
 *
 * Extracted rather than transcribed: commands copied into this file would drift
 * from the README exactly as the README drifts from the code.
 */
const connectionString = process.env.TEST_DATABASE_URL;

// `fileURLToPath` rather than `.pathname`, which leaves `%20` in place and would
// look for a file that does not exist on a checkout path containing spaces.
const readmePath = fileURLToPath(new URL("../../../README.md", import.meta.url));

/** The tools the README tells a reader to use. Without them there is nothing to check. */
const hasShell = Bun.which("curl") !== null && Bun.which("bash") !== null;

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl!: string;
let workspace!: string;

/**
 * Substitutes what the README cannot say for itself — where the server is
 * listening, and identities unique per run so a second run is not a duplicate
 * sign-up — and makes failures legible, which the README deliberately does not:
 * it keeps the plainer command that shows a reader an error instead of stopping
 * on it.
 *
 * `curl -s` exits 0 on an HTTP error, so under `set -e` a step answering 404
 * carries on and the run fails only if that step's output happened to be
 * asserted; a broken progress step was measured passing that way. The wrapper
 * makes curl fail on an error status, puts back the message `-s` silenced, and
 * names the request. It exits rather than returns, and the `ERR` trap is left to
 * the failures that are not curl's, because a failing function leaves the trap
 * naming that function's last command — a line pointing nowhere.
 *
 * `--fail-with-body` needs curl 7.76. An older one fails this test rather than
 * skipping it, its complaint landing in the errors the assertion prints.
 */
function runnable(block: string): string {
  const unique = crypto.randomUUID().slice(0, 8);
  const strict = [
    "set -euo pipefail",
    `trap 'echo "failed: $BASH_COMMAND" >&2' ERR`,
    'curl() { command curl --fail-with-body --show-error "$@" || { local status=$?; echo "failed: curl $*" >&2; exit "$status"; }; }',
  ].join("\n");

  return block
    .replace("BRAIVO=http://localhost:3000", `${strict}\nBRAIVO=${baseUrl}`)
    .replace("owner@example.com", `owner-${unique}@example.com`)
    .replace("example-school", `example-school-${unique}`);
}

describe.skipIf(!connectionString || !hasShell)("the README walkthrough", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    // The walkthrough writes a cookie jar beside itself. Somewhere of its own,
    // because inheriting the runner's directory drops `jar.txt` into the
    // repository — and two runs would then share one learner's session.
    workspace = await mkdtemp(join(tmpdir(), "braivo-quickstart-"));

    // The app needs the origin it is served from, and the port is only known
    // once something is listening. Nothing reaches `app` until a request
    // arrives, by which point the line below has run.
    let app: Api;
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
    baseUrl = `http://localhost:${server.port}`;

    const database = testing.sharedDatabase(connectionString ?? "");
    app = createApi({
      database,
      baseUrl,
      auth: createAuth({
        database,
        secret: "quickstart-secret-long-enough-32ch",
        baseURL: baseUrl,
      }),
    });
  });

  afterAll(async () => {
    await server?.stop(true);
    await rm(workspace, { recursive: true, force: true });
  });

  test("still runs, and still answers what it says it answers", async () => {
    const readme = await Bun.file(readmePath).text();
    const block = readme.split("## The API, end to end")[1]?.match(/```bash\n([\s\S]*?)```/)?.[1];

    // Guards the guard: a rename of that heading would otherwise skip silently.
    expect(block).toBeTypeOf("string");

    // Spawned rather than run synchronously: the server answering these requests
    // lives in this process, so blocking the loop to wait would deadlock against
    // the very curl it is waiting for.
    const shell = Bun.spawn(["bash", "-c", runnable(block!)], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, exitCode] = await Promise.all([
      new Response(shell.stdout).text(),
      new Response(shell.stderr).text(),
      shell.exited,
    ]);

    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
    // The README prints these answers as comments. A walkthrough that ran but no
    // longer taught anything would pass on the exit code alone.
    expect(output).toContain('"intent":"introduce"');
    expect(output).toContain('"outcome":"failure"');
    expect(output).toContain('"intent":"reteach"');
    expect(output).toContain('"phase":"acquiring"');
    expect(output).toContain('"phase":"unseen"');
  });
});
