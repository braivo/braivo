// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import { session } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { createApi } from "../api/index.ts";
import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { readSource } from "../persistence/index.ts";
import { loadCredentials, readServer, saveCredentials } from "./credentials.ts";
import { login, logout, remoteClient, signIn, whoAmI } from "./remote.ts";
import { addSourceFromFile } from "./sources.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const server = "http://localhost:3000";
const outbox = createOutbox();
const auth = createAuth({
  database,
  secret: "cli-test-secret-that-is-long-enough-32",
  baseURL: server,
  sendMail: outbox.sendMail,
});
const api = createApi({ auth, database, baseUrl: server });

/** The network, for these commands: the real app, addressed by full URL as a remote one is. */
const fetch = ((input: string | URL, init?: RequestInit) =>
  api.request(input.toString(), init)) as unknown as typeof globalThis.fetch;

const organizationId = "cli-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

let teacher!: { cookie: string; id: string; email: string };

async function signUp() {
  const email = `cli-test-${crypto.randomUUID()}@example.com`;
  const { cookie, id } = await signInWithCode(
    (path, init) => api.request(`/api/auth${path}`, init),
    outbox,
    { email, name: email },
  );
  return { cookie, id, email };
}

/**
 * The content owner's side of the flow, as the console page does it: follow
 * the link the CLI printed, then approve or deny.
 */
async function answer(link: string, decision: "approve" | "deny") {
  const userCode = new URL(link).searchParams.get("user_code") ?? "";
  await api.request(`/api/auth/device?user_code=${userCode}`, {
    headers: { cookie: teacher.cookie },
  });
  await api.request(`/api/auth/device/${decision}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacher.cookie, origin: server },
    body: JSON.stringify({ userCode }),
  });
}

/** Where a test keeps its credentials: a fresh file, never the real one. */
const credentialsFile = async () =>
  join(await mkdtemp(join(tmpdir(), "braivo-credentials-")), "credentials.json");

/**
 * Signs in as the CLI does, with the content owner answering in their browser
 * while it waits. The first wait is where they answer; waits are otherwise
 * skipped, since the flow's pacing is the server's to enforce, not the test's.
 */
async function signInAnswering(decision: "approve" | "deny") {
  const printed: string[] = [];
  const waits: number[] = [];
  const path = await credentialsFile();
  const credentials = login(path, server, {
    fetch,
    print: (line) => printed.push(line),
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      if (waits.length === 1) await answer(printed[0]!.replace(/^Open /, ""), decision);
    },
  });
  const { token } = await credentials;
  return { token, path, printed, waits };
}

describe("where the CLI may send a token", () => {
  test("is an https origin, or this machine over http", () => {
    expect(readServer("https://braivo.example.com/console/")).toBe("https://braivo.example.com");
    expect(readServer("http://localhost:3000")).toBe("http://localhost:3000");
    expect(readServer("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  test.each([
    ["plain http elsewhere", "http://braivo.example.com"],
    ["not a URL", "braivo.example.com"],
    ["another scheme", "ftp://braivo.example.com"],
  ])("refuses %s", (_label, value) => {
    expect(() => readServer(value)).toThrow();
  });

  test("is checked where the token is attached, whatever built the credentials", () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response();
    }) as unknown as typeof globalThis.fetch;

    expect(() => remoteClient({ server: "http://braivo.example.com", token: "t" }, spy)).toThrow(
      /https/,
    );
    expect(fetched).toBe(false);
  });
});

describe("the saved token", () => {
  test("is never replaced by signing in again", async () => {
    const path = await credentialsFile();
    const saved = { server, token: "t" };
    await saveCredentials(path, saved);
    const unreachable = (() => {
      throw new Error("Contacted the server.");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      login(path, "https://another.example.com", {
        fetch: unreachable,
        print: () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow(`Already signed in to ${server}. Run \`braivo logout\` first.`);
    expect(await loadCredentials(path)).toEqual(saved);
  });

  test("keeps the token while it still signs in, whatever sign-out answered", async () => {
    // Better Auth answers success even when deleting the session failed.
    const stillSignedIn = (async (input: string | URL) =>
      input.toString().endsWith("/sign-out")
        ? Response.json({ success: true })
        : Response.json({ user: { email: "teacher@example.com" } })) as typeof globalThis.fetch;
    const path = await credentialsFile();
    const credentials = { server, token: "t" };
    await saveCredentials(path, credentials);

    await expect(logout(path, stillSignedIn)).rejects.toThrow(/may still work/);
    expect(await loadCredentials(path)).toEqual(credentials);
  });

  test("keeps the token when the server's answer is not a session or null", async () => {
    const malformed = (async (input: string | URL) =>
      input.toString().endsWith("/sign-out")
        ? Response.json({ success: true })
        : Response.json({})) as typeof globalThis.fetch;
    const path = await credentialsFile();
    const credentials = { server, token: "t" };
    await saveCredentials(path, credentials);

    await expect(logout(path, malformed)).rejects.toThrow(/unexpected session/);
    expect(await loadCredentials(path)).toEqual(credentials);
  });

  test("says the session is over when the file cannot be deleted", async () => {
    const signedOut = (async (input: string | URL) =>
      input.toString().endsWith("/sign-out")
        ? Response.json({ success: true })
        : Response.json(null)) as typeof globalThis.fetch;
    const path = await credentialsFile();
    await saveCredentials(path, { server, token: "t" });
    await chmod(dirname(path), 0o500);

    try {
      await expect(logout(path, signedOut)).rejects.toThrow(
        `Signed out of ${server}, but could not delete`,
      );
    } finally {
      await chmod(dirname(path), 0o700);
    }
  });
});

/**
 * A server that hands out a code and then answers each poll from `polls` in
 * turn: a `Response`, or an `Error` for a connection that never answered.
 */
function deviceServer(polls: (Response | Error)[], expiresIn = 600) {
  return (async (input: string | URL) => {
    if (input.toString().endsWith("/device/code")) {
      return Response.json({
        device_code: "device",
        user_code: "ABCD2345",
        verification_uri_complete: `${server}/device?user_code=ABCD2345`,
        interval: 5,
        expires_in: expiresIn,
      });
    }
    const next =
      polls.shift() ?? Response.json({ error: "authorization_pending" }, { status: 400 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
}

describe("polling for the token", () => {
  test("keeps going after a connection fails, polling less often", async () => {
    const waits: number[] = [];

    const token = await signIn(server, {
      fetch: deviceServer([new TypeError("timed out"), Response.json({ access_token: "token" })]),
      print: () => {},
      sleep: async (milliseconds) => void waits.push(milliseconds),
    });

    expect(token).toBe("token");
    expect(waits).toEqual([5000, 10_000]);
  });

  test("slows down when asked to", async () => {
    const waits: number[] = [];

    await signIn(server, {
      fetch: deviceServer([
        Response.json({ error: "slow_down" }, { status: 400 }),
        Response.json({ access_token: "token" }),
      ]),
      print: () => {},
      sleep: async (milliseconds) => void waits.push(milliseconds),
    });

    expect(waits).toEqual([5000, 10_000]);
  });

  test("stops once the code has had its lifetime, approved or not", async () => {
    const waits: number[] = [];

    const signingIn = signIn(server, {
      fetch: deviceServer([], 12),
      print: () => {},
      sleep: async (milliseconds) => void waits.push(milliseconds),
    });

    await expect(signingIn).rejects.toThrow("The code expired");
    expect(waits).toEqual([5000, 5000, 5000]);
  });
});

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the CLI, signed in through the device flow", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });
  });

  test("signs in as the content owner who approved, and adds a source as them", async () => {
    const { token, printed, waits } = await signInAnswering("approve");
    const credentials = { server, token };

    // The console link, and the code to check it against.
    expect(printed[0]).toMatch(/^Open http:\/\/localhost:3000\/device\?user_code=/);
    expect(waits[0]).toBe(5000);
    expect(await whoAmI(credentials, fetch)).toEqual({ email: teacher.email });

    const sourceId = await addSourceFromFile({
      client: remoteClient(credentials, fetch),
      organizationId,
      file: "-",
      title: "Transcript",
      url: "https://www.youtube.com/watch?v=abc123",
      language: "es",
      readStdin: async () => "Hola, ¿qué tal?",
    });

    expect(await readSource(database, organizationId, sourceId)).toMatchObject({
      title: "Transcript",
      text: "Hola, ¿qué tal?",
      url: "https://www.youtube.com/watch?v=abc123",
      language: "es",
    });
  });

  test("gives up, saying so, when the content owner denies", async () => {
    await expect(signInAnswering("deny")).rejects.toThrow("Sign-in was denied in the browser.");
  });

  test("logs out, so the token no longer signs in, and forgets it", async () => {
    const { token, path } = await signInAnswering("approve");
    const credentials = { server, token };
    expect(await loadCredentials(path)).toEqual(credentials);

    expect(await logout(path, fetch)).toBe(server);

    expect(await whoAmI(credentials, fetch)).toBeUndefined();
    expect(await loadCredentials(path)).toBeUndefined();
    expect(await logout(path, fetch)).toBeUndefined();

    // A token whose session already ended is forgotten too.
    await saveCredentials(path, credentials);
    expect(await logout(path, fetch)).toBe(server);
    expect(await loadCredentials(path)).toBeUndefined();
  });

  test("asks who a token is without renewing its session", async () => {
    // Otherwise checking a sign-out that failed would extend the session.
    const { token } = await signInAnswering("approve");
    const dueForRenewal = new Date(Date.now() + 60 * 60 * 1000);
    await database
      .update(session)
      .set({ expiresAt: dueForRenewal })
      .where(eq(session.token, token));

    expect(await whoAmI({ server, token }, fetch)).toEqual({ email: teacher.email });

    const [stored] = await database
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.token, token));
    expect(stored?.expiresAt).toEqual(dueForRenewal);
  });

  test("reads a token that no longer signs anyone in as nobody", async () => {
    expect(await whoAmI({ server, token: "signed-out" }, fetch)).toBeUndefined();
  });
});

describe("adding a file as a source", () => {
  const client = { addSource: async (input: object) => JSON.stringify(input) };

  test("names it after the file, without its extension", async () => {
    const added = await addSourceFromFile({
      client: client as never,
      organizationId: "o",
      file: fileURLToPath(import.meta.url),
      readStdin: async () => "",
    });

    expect(JSON.parse(added)).toMatchObject({ organizationId: "o", title: "remote.test" });
  });

  test("reads a caption file into cues, so the source is timed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "braivo-"));
    const file = join(directory, "Los saludos.es.vtt");
    await writeFile(file, "WEBVTT\n\n00:01.500 --> 00:03.000\nHola.\n");

    const added = await addSourceFromFile({
      client: client as never,
      organizationId: "o",
      file,
      readStdin: async () => "",
    });

    expect(JSON.parse(added)).toEqual({
      organizationId: "o",
      title: "Los saludos.es",
      cues: [{ at: 1.5, text: "Hola." }],
    });
  });

  test("names the caption file that could not be read, and why", async () => {
    const directory = await mkdtemp(join(tmpdir(), "braivo-"));
    const file = join(directory, "lesson.vtt");
    await writeFile(file, "Hola.\n");

    await expect(
      addSourceFromFile({
        client: client as never,
        organizationId: "o",
        file,
        readStdin: async () => "",
      }),
    ).rejects.toThrow(`${file}: This is not a WebVTT file`);
  });

  test("sends pdftotext's pages as pages, numbered from 1, leaving out blank ones", async () => {
    const added = await addSourceFromFile({
      client: client as never,
      organizationId: "o",
      file: "-",
      title: "Libro",
      readStdin: async () => "Portada\f\n \fHola.\n\fAdiós.\n\f",
    });

    expect(JSON.parse(added)).toEqual({
      organizationId: "o",
      title: "Libro",
      pages: [
        { page: "1", text: "Portada" },
        { page: "3", text: "Hola.\n" },
        { page: "4", text: "Adiós.\n" },
      ],
    });
  });

  test("says so when no page has text, as a scanned PDF's does not", async () => {
    await expect(
      addSourceFromFile({
        client: client as never,
        organizationId: "o",
        file: "-",
        title: "Libro",
        readStdin: async () => "\f \f\f",
      }),
    ).rejects.toThrow("Standard input: no page has text; a scanned PDF needs OCR first.");
  });

  test("uploads the original, as its extension's type, and keeps it with the source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "braivo-"));
    const pdf = join(directory, "libro.pdf");
    await writeFile(pdf, "%PDF-1.7");
    const uploads: string[] = [];
    const uploading = {
      ...client,
      uploadFile: async ({ file }: { file: Blob }) => {
        uploads.push(`${file.type}: ${await file.text()}`);
        return { fileId: "f".repeat(64) };
      },
    };

    const added = await addSourceFromFile({
      client: uploading as never,
      organizationId: "o",
      file: "-",
      title: "Libro",
      original: pdf,
      readStdin: async () => "Hola.",
    });

    expect(uploads).toEqual(["application/pdf: %PDF-1.7"]);
    expect(JSON.parse(added)).toEqual({
      organizationId: "o",
      title: "Libro",
      original: "f".repeat(64),
      text: "Hola.",
    });

    // Text refused before sending uploads nothing.
    await expect(
      addSourceFromFile({
        client: uploading as never,
        organizationId: "o",
        file: "-",
        title: "Libro",
        original: pdf,
        readStdin: async () => "\f \f",
      }),
    ).rejects.toThrow("no page has text");
    for (const text of [" \n", "Hola\u0000"]) {
      await expect(
        addSourceFromFile({
          client: uploading as never,
          organizationId: "o",
          file: "-",
          title: "Libro",
          original: pdf,
          readStdin: async () => text,
        }),
      ).rejects.toThrow("Standard input: no text Braivo can store");
    }
    expect(uploads).toHaveLength(1);
  });

  test("needs a title for standard input, which has no name", async () => {
    await expect(
      addSourceFromFile({
        client: client as never,
        organizationId: "o",
        file: "-",
        readStdin: async () => "Hola",
      }),
    ).rejects.toThrow("--title");
  });
});
