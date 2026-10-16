// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "vite-plus";
import { afterEach, expect, test } from "vite-plus/test";

import { braivoApi } from "../dev-proxy.ts";
import { childEnvironment } from "./cli.ts";
import type { Demo } from "./environment.ts";

const demo: Demo = {
  id: "0123456789ab",
  worktree: "/work",
  database: "braivo_demo_0123456789ab",
  storage: "/work/.dev-demo/storage",
  ports: { server: 3100, learn: 5183, console: 5184 },
  targetUrl: "postgres://me:secret@localhost/postgres",
  authSecret: "a".repeat(43),
};

/** What `.env` and a developer's shell might hold, none of which a demo may use. */
const ordinary = {
  DATABASE_URL: "postgres://localhost/braivo",
  BETTER_AUTH_SECRET: "the-development-secret-long-enough-to-pass",
  BRAIVO_URL: "http://localhost:5174",
  PORT: "3000",
  BRAIVO_SMTP_URL: "smtp://mail.example.com",
  BRAIVO_FILES: "s3://bucket",
  ANTHROPIC_API_KEY: "sk-ant",
  GOOGLE_CLIENT_ID: "google",
  BRAIVO_SELF_SERVE_DOMAIN: "localhost",
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function withDotenv(contents: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "braivo-dotenv-"));
  directories.push(directory);
  writeFileSync(
    join(directory, ".env"),
    Object.entries(contents)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  );
  return directory;
}

test("a child gets the demo's settings and a few to run by, nothing else inherited", () => {
  const environment = childEnvironment(demo, { ...ordinary, PATH: "/bin", HOME: "/home/me" });

  expect(environment).toEqual({
    PATH: "/bin",
    HOME: "/home/me",
    DATABASE_URL: "postgres://me:secret@localhost/braivo_demo_0123456789ab",
    BETTER_AUTH_SECRET: demo.authSecret,
    BRAIVO_URL: "http://127.0.0.1:5184",
    PORT: "3100",
    BRAIVO_FILES: "/work/.dev-demo/storage",
    BRAIVO_LEARN_PORT: "5183",
  });
});

test("the server, started without Bun's .env loading, reads none of a .env beside it", async () => {
  const directory = withDotenv(ordinary);
  const server = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", "console.log(JSON.stringify(process.env))"],
    { cwd: directory, env: childEnvironment(demo, process.env), stdout: "pipe" },
  );
  const seen = JSON.parse(await new Response(server.stdout).text()) as Record<string, string>;

  expect(seen).toMatchObject({ DATABASE_URL: expect.stringContaining(demo.database) });
  for (const name of [
    "BRAIVO_SMTP_URL",
    "ANTHROPIC_API_KEY",
    "GOOGLE_CLIENT_ID",
    "BRAIVO_SELF_SERVE_DOMAIN",
  ]) {
    expect(seen[name]).toBeUndefined();
  }
});

test("the apps' proxy follows the demo's server and site over a .env's", () => {
  // As the apps' configurations read it: `loadEnv` over the repository's root.
  const directory = withDotenv(ordinary);
  const saved = { ...process.env };
  Object.assign(process.env, childEnvironment(demo, {}));
  try {
    const proxy = braivoApi(loadEnv("development", directory, ["BRAIVO_", "PORT"]));
    expect(proxy["/api"]?.target).toBe("http://localhost:3100");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
