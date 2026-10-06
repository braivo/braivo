// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

import { type Database, runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
// Through the package's own name: the entry a Worker imports.
import { createServer, type FileStore, readServerConfig, smtpMail } from "@braivo/server";
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
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FILES: { get(key: string): Promise<unknown> };
}

/** Configured from a Worker-shaped `env`. */
function testServer(
  options: {
    ai?: Pick<Env, "ANTHROPIC_API_KEY" | "BRAIVO_AI_ORGANIZATIONS">;
    google?: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;
    cachedDatabase?: Database;
    files?: FileStore;
  } = {},
) {
  const env: Env = {
    BETTER_AUTH_SECRET: "server-test-secret-that-is-long-enough",
    BRAIVO_URL: baseUrl,
    FILES: { get: async () => undefined },
    ...options.ai,
    ...options.google,
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

  test("offers Google sign-in when the environment holds Google's client", async () => {
    const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    const methods = async (server: ReturnType<typeof testServer>) =>
      (await server.request(`${baseUrl}/api/sign-in-methods`)).json();

    expect(await methods(testServer({ google }))).toEqual({ google: true });
    expect(await methods(testServer())).toEqual({ google: false });
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

test("smtpMail sends a message through SMTP, as the configured sender", async () => {
  // Just enough of a server for Nodemailer to deliver one message to; anything
  // else gets a 500, so a changed dialogue fails at once rather than timing out.
  const transcript: string[] = [];
  let connection: Socket | undefined;
  const server = createTcpServer((socket) => {
    connection = socket;
    let inData = false;
    socket.write("220 test\r\n");
    // Whole lines, however TCP splits them.
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      transcript.push(line);
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 ok\r\n");
        }
      } else if (line === "DATA") {
        inData = true;
        socket.write("354 go\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else if (/^(EHLO |MAIL FROM:|RCPT TO:)/.test(line)) {
        socket.write("250 ok\r\n");
      } else socket.write("500 unexpected\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const sendMail = smtpMail({
      url: `smtp://127.0.0.1:${port}`,
      from: "Braivo <codes@example.com>",
    });
    await sendMail({
      to: "ada@example.com",
      subject: "Your code",
      text: "text-123456",
      html: "<p>html-123456</p>",
    });
  } finally {
    // Closing the server leaves an open connection, as a failed send would.
    connection?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  expect(transcript).toEqual(
    expect.arrayContaining([
      "MAIL FROM:<codes@example.com>",
      "RCPT TO:<ada@example.com>",
      "From: Braivo <codes@example.com>",
      "Subject: Your code",
      "text-123456",
      "<p>html-123456</p>",
    ]),
  );
});
