// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

import { type Database, runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
// Through the package's own name: the entry a Worker imports.
import { createServer, type FileStore, readServerConfig, smtpMail } from "@braivo/server";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";

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
  BRAIVO_PRIVACY_URL?: string;
  BRAIVO_TERMS_URL?: string;
  FILES: { get(key: string): Promise<unknown> };
}

/** Configured from a Worker-shaped `env`. */
function testServer(
  options: {
    ai?: Pick<Env, "ANTHROPIC_API_KEY" | "BRAIVO_AI_ORGANIZATIONS">;
    google?: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;
    legal?: Pick<Env, "BRAIVO_PRIVACY_URL" | "BRAIVO_TERMS_URL">;
    cachedDatabase?: Database;
    files?: FileStore;
    clientIdMetadataDocuments?: "strictly-public" | false;
    wrapClientMetadataFetch?: Parameters<typeof createServer>[0]["wrapClientMetadataFetch"];
  } = {},
) {
  const env: Env = {
    BETTER_AUTH_SECRET: "server-test-secret-that-is-long-enough",
    BRAIVO_URL: baseUrl,
    FILES: { get: async () => undefined },
    ...options.ai,
    ...options.google,
    ...options.legal,
  };
  return createServer({
    config: readServerConfig(env),
    database,
    cachedDatabase: options.cachedDatabase,
    files: options.files,
    sendMail: outbox.sendMail,
    clientIdMetadataDocuments: options.clientIdMetadataDocuments,
    wrapClientMetadataFetch: options.wrapClientMetadataFetch,
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

  test("offers Google sign-in, and links the operator's legal pages, as the environment says", async () => {
    const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    const legal = {
      BRAIVO_PRIVACY_URL: "https://fernwood.example/privacy",
      BRAIVO_TERMS_URL: "https://fernwood.example/terms",
    };
    const settings = async (server: ReturnType<typeof testServer>) =>
      (await server.request(`${baseUrl}/api/sign-in-settings`)).json();

    expect(await settings(testServer({ google }))).toEqual({ google: true, legal: null });
    expect(await settings(testServer({ legal }))).toEqual({
      google: false,
      legal: {
        privacy: "https://fernwood.example/privacy",
        terms: "https://fernwood.example/terms",
      },
    });
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

  test("advertises CIMD, withdrawing `private_key_jwt` where documents are not fetched", async () => {
    const advertisedAuthMethods = async (server: ReturnType<typeof testServer>) => {
      const documents = ["oauth-authorization-server", "openid-configuration"].map(async (name) => {
        const url = `${baseUrl}/api/auth/.well-known/${name}`;
        expect((await server.request(url, { method: "HEAD" })).status).toBe(200);
        const answer = await server.request(url);
        expect(answer.status).toBe(200);
        const metadata = (await answer.json()) as {
          client_id_metadata_document_supported?: boolean;
          token_endpoint_auth_methods_supported: string[];
        };
        // As ChatGPT and Claude read it: CIMD, with public clients.
        expect(metadata.client_id_metadata_document_supported).toBe(true);
        expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
        return metadata.token_endpoint_auth_methods_supported;
      });
      return Promise.all(documents);
    };

    // Where documents are fetched, a client's keys are too.
    for (const fetching of [
      testServer(),
      testServer({ clientIdMetadataDocuments: "strictly-public" }),
    ])
      for (const methods of await advertisedAuthMethods(fetching))
        expect(methods).toContain("private_key_jwt");
    // Where none are (ADR 0045), ChatGPT would sign with a key wherever
    // `private_key_jwt` is offered, and registered clients have none.
    const worker = testServer({ clientIdMetadataDocuments: false });
    for (const methods of await advertisedAuthMethods(worker))
      expect(methods).not.toContain("private_key_jwt");
    // Other answers pass unchanged; this one goes through `auth.handler` too.
    const resource = await worker.request(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(((await resource.json()) as { resource: string }).resource).toBe(`${baseUrl}/mcp`);
  });

  test("fetches client ID metadata documents through a Worker's `fetch` where asked", async () => {
    vi.stubGlobal("Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: true } });
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const clientId = `https://client.example/${crypto.randomUUID()}.json`;
    try {
      const authorizing = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
      authorizing.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      }).toString();
      await testServer({ clientIdMetadataDocuments: "strictly-public" }).request(authorizing, {
        headers: { cookie },
      });

      expect(fetched.mock.calls.map(([asked]) => (asked as Request).url)).toEqual([clientId]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  test("wraps the fetch of a client's document and of its keys, through the fetch given", async () => {
    vi.stubGlobal("Cloudflare", { compatibilityFlags: { global_fetch_strictly_public: true } });
    const clientId = `https://client.example/${crypto.randomUUID()}.json`;
    // A client authenticating with a key, so its `jwks_uri` is fetched too:
    // on the document's origin, as Better Auth requires.
    const jwksUri = "https://client.example/jwks.json";
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      (input as Request).url === clientId
        ? Response.json({
            client_id: clientId,
            client_name: "Keyed",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "private_key_jwt",
            jwks_uri: jwksUri,
          })
        : new Response(null, { status: 404 }),
    );
    const wrapped: string[] = [];
    try {
      const server = testServer({
        clientIdMetadataDocuments: "strictly-public",
        wrapClientMetadataFetch: (fetch) => async (input, init) => {
          wrapped.push(new Request(input).url);
          return fetch(input, init);
        },
      });
      const claims = { iss: clientId, sub: clientId, aud: `${baseUrl}/api/auth`, jti: "j" };
      const unsigned = [
        { alg: "RS256", kid: "k" },
        { ...claims, exp: Date.now() / 1000 + 60 },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
      await server.request(`${baseUrl}/api/auth/oauth2/introspect`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "t",
          client_id: clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: `${unsigned}.c2ln`,
        }),
      });

      expect(wrapped).toEqual([clientId, jwksUri]);
      // Each through the strictly public fetch the wrapper was given.
      expect(fetched.mock.calls.map(([asked]) => (asked as Request).url)).toEqual(wrapped);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
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
