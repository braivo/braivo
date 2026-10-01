// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { credentialsPath, loadCredentials, saveCredentials } from "./credentials.ts";

const scratch = () => mkdtemp(join(tmpdir(), "braivo-credentials-"));

describe("credentials", () => {
  test("live under the XDG config directory when one is set", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/braivo/credentials.json");
    expect(credentialsPath({ XDG_CONFIG_HOME: " " })).toMatch(
      /\.config\/braivo\/credentials\.json$/,
    );
  });

  test("are saved readable by their owner only, and read back", async () => {
    const path = join(await scratch(), "braivo", "credentials.json");
    const credentials = { server: "https://braivo.example.com", token: "secret" };

    await saveCredentials(path, credentials);

    expect(await loadCredentials(path)).toEqual(credentials);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("replace a file left readable by others rather than writing into it", async () => {
    // Writing into it would show the token to others until it was tightened;
    // a new file, renamed over it, is private from its first byte.
    const directory = await scratch();
    const path = join(directory, "credentials.json");
    await writeFile(path, "{}", { mode: 0o644 });
    const before = await stat(path);

    await saveCredentials(path, { server: "https://braivo.example.com", token: "secret" });

    const after = await stat(path);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  test("refuse a saved address a token may not be sent to", async () => {
    const path = join(await scratch(), "credentials.json");
    await writeFile(path, JSON.stringify({ server: "http://braivo.example.com", token: "t" }));

    await expect(loadCredentials(path)).rejects.toThrow(/https/);
  });

  test("are absent before signing in, and refused when not credentials", async () => {
    const directory = await scratch();
    const stray = join(directory, "stray.json");
    await writeFile(stray, '{"hello":"world"}');

    expect(await loadCredentials(join(directory, "missing.json"))).toBeUndefined();
    await expect(loadCredentials(stray)).rejects.toThrow(/braivo login/);
  });
});
