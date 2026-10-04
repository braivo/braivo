// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Database, runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
// Through the package's own name: the entry a Worker imports.
import { createServer, type FileStore, readServerConfig } from "@braivo/server";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { codeSentTo, createOutbox, signInWithCode } from "./auth/testing.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "server-test-org";
const baseUrl = "https://server-test.example.com";
const outbox = createOutbox();

/** An interface, as Wrangler generates it, with a binding beside the variables. */
interface Env {
  BETTER_AUTH_SECRET: string;
  BRAIVO_URL: string;
  ANTHROPIC_API_KEY?: string;
  BRAIVO_AI_ORGANIZATIONS?: string;
  FILES: { get(key: string): Promise<unknown> };
}

/** Configured from a Worker-shaped `env`. */
function testServer(
  options: {
    ai?: Pick<Env, "ANTHROPIC_API_KEY" | "BRAIVO_AI_ORGANIZATIONS">;
    cachedDatabase?: Database;
    files?: FileStore;
  } = {},
) {
  const env: Env = {
    BETTER_AUTH_SECRET: "server-test-secret-that-is-long-enough",
    BRAIVO_URL: baseUrl,
    FILES: { get: async () => undefined },
    ...options.ai,
  };
  return createServer({
    config: readServerConfig(env),
    database,
    cachedDatabase: options.cachedDatabase,
    files: options.files,
    sendMail: outbox.sendMail,
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("createServer", () => {
  let cookie!: string;
  /** A request from an administrator of `organizationId`. */
  const asAdmin = (server: ReturnType<typeof testServer>, method: string, path: string) =>
    server.request(`${baseUrl}/api/organizations/${organizationId}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: baseUrl, cookie },
      ...(method === "POST" && { body: "{}" }),
    });

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    const server = testServer();
    const admin = await signInWithCode(
      (path, init) => server.request(`${baseUrl}/api/auth${path}`, init),
      outbox,
      { email: `server-test-${crypto.randomUUID()}@example.com` },
    );
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [admin.id],
      at: new Date(),
    });
    cookie = admin.cookie;
  });

  test("sends sign-in codes through the host's mail, on the configured origin alone", async () => {
    const email = `server-test-${crypto.randomUUID()}@example.com`;
    const send = (origin: string) =>
      testServer().request(`${origin}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, type: "sign-in" }),
      });

    expect((await send("https://elsewhere.example.com")).status).toBe(404);
    expect((await send(baseUrl)).status).toBe(200);
    expect(codeSentTo(outbox, email)).toMatch(/^\d{6}$/);
  });

  test("reads a source through the host's query cache", async () => {
    const statements: string[] = [];
    const cachedDatabase = testing.recordingDatabase(connectionString ?? "", statements);
    try {
      expect((await asAdmin(testServer({ cachedDatabase }), "GET", "/sources/none")).status).toBe(
        404,
      );
      expect(statements).not.toEqual([]);
    } finally {
      await cachedDatabase.$client.end();
    }
  });

  test("keeps files only with the host's store", async () => {
    const store: FileStore = { put: async () => {}, get: async () => undefined };

    expect((await asAdmin(testServer(), "GET", "/files/none")).status).toBe(501);
    expect((await asAdmin(testServer({ files: store }), "GET", "/files/none")).status).toBe(404);
  });

  test("enables AI only when configured, and only for the organizations it names", async () => {
    // Refused before any model is asked: 501 says there is none, 403 that one
    // exists but this organization may not spend it.
    const notEntitled = testServer({
      ai: { ANTHROPIC_API_KEY: "key", BRAIVO_AI_ORGANIZATIONS: "server-test-other-org" },
    });

    expect((await asAdmin(testServer(), "POST", "/sources/none/draft")).status).toBe(501);
    expect((await asAdmin(notEntitled, "POST", "/sources/none/draft")).status).toBe(403);
  });
});
