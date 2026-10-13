// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { access, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test } from "vite-plus/test";

// install.sh run against stand-ins for `uname`, `sysctl`, and `curl`, which
// logs what it was asked for and "downloads" a `braivo` that prints a version.

const script = fileURLToPath(new URL("./install.sh", import.meta.url));

let directory!: string;
let bin!: string;
let dir!: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "braivo-install-"));
  bin = join(directory, "bin");
  dir = join(directory, "home", ".local", "bin");
  await stub("uname", `[ "$1" = -s ] && echo "$FAKE_OS" || echo "$FAKE_ARCH"`);
  await stub("sysctl", `echo "\${FAKE_TRANSLATED:-0}"`);
  await stub(
    "curl",
    `echo "$2" >> "${join(directory, "requested")}"
     [ "\${FAKE_FAIL:-}" = download ] && exit 22
     [ "\${FAKE_FAIL:-}" = start ] && echo 'exit 132' > "$4" && exit
     printf '#!/bin/sh\\necho "braivo 9.9.9"\\n' > "$4"`,
  );
});

async function stub(name: string, body: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(bin, name), 0o755);
}

async function install(environment: Record<string, string>, path = "") {
  const child = Bun.spawn(["sh", script], {
    env: {
      HOME: join(directory, "home"),
      PATH: `${bin}:/usr/bin:/bin${path}`,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const requested = await readFile(join(directory, "requested"), "utf8").catch(() => "");
  return { stdout, stderr, code, requested: requested.trim() };
}

describe("install.sh", () => {
  test("puts the latest release's build for this machine in ~/.local/bin", async () => {
    const run = await install({ FAKE_OS: "Linux", FAKE_ARCH: "x86_64" });

    expect(run.code).toBe(0);
    expect(run.requested).toBe(
      "https://github.com/braivo/braivo/releases/latest/download/braivo-linux-x64",
    );
    await access(join(dir, "braivo"));
    expect(await readdir(dir)).toEqual(["braivo"]);
    expect(run.stdout).toContain(`Installed braivo 9.9.9 as ${dir}/braivo`);
    expect(run.stdout).toContain(`Add ${dir} to your PATH`);
  });

  test("takes the release and directory asked for, and says nothing of a PATH that has it", async () => {
    const custom = join(directory, "tools");
    const run = await install(
      {
        FAKE_OS: "Darwin",
        FAKE_ARCH: "arm64",
        BRAIVO_VERSION: "v0.1.0",
        BRAIVO_INSTALL_DIR: custom,
      },
      `:${custom}`,
    );

    expect(run.code).toBe(0);
    expect(run.requested).toBe(
      "https://github.com/braivo/braivo/releases/download/v0.1.0/braivo-darwin-arm64",
    );
    await access(join(custom, "braivo"));
    expect(run.stdout).not.toContain("PATH");
  });

  test("takes the Apple silicon build from a shell under Rosetta", async () => {
    const run = await install({ FAKE_OS: "Darwin", FAKE_ARCH: "x86_64", FAKE_TRANSLATED: "1" });

    expect(run.requested).toMatch(/braivo-darwin-arm64$/);
  });

  test("downloads nothing for a system with no build", async () => {
    const run = await install({ FAKE_OS: "FreeBSD", FAKE_ARCH: "amd64" });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not FreeBSD");
    expect(run.requested).toBe("");
  });

  test.each(["download", "start"])(
    "keeps the installed braivo, and leaves nothing, when the new one fails to %s",
    async (failure) => {
      await install({ FAKE_OS: "Linux", FAKE_ARCH: "aarch64" });
      const before = await readFile(join(dir, "braivo"), "utf8");

      const run = await install({ FAKE_OS: "Linux", FAKE_ARCH: "aarch64", FAKE_FAIL: failure });

      expect(run.code).not.toBe(0);
      expect(await readdir(dir)).toEqual(["braivo"]);
      expect(await readFile(join(dir, "braivo"), "utf8")).toBe(before);
    },
  );
});
