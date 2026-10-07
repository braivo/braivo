// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The materials routes (`materials.ts`): sources, files, reading a file's
// text, and drafting a course, each route's shapes and refusals. The whole
// flow they serve, from a PDF to a tutor, is `pdf-to-tutor.test.ts`.

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import { session } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { type Model, ModelUnavailable } from "../ai/index.ts";
import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { bucketStore, directoryStore } from "../storage/index.ts";
import { createApi } from "./app.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const outbox = createOutbox();
const auth = createAuth({
  database,
  secret: "materials-test-secret-long-enough-32",
  baseURL: "http://localhost:3000",
  sendMail: outbox.sendMail,
});
const baseUrl = "http://localhost:3000";
/** No file store and no model: what each route answers without them. */
const api = createApi({ auth, database, baseUrl });
/** Stands in for a query cache, recording what is read through it. */
const cachedStatements: string[] = [];
const cachedDatabase = testing.recordingDatabase(connectionString ?? "", cachedStatements);
afterAll(() => cachedDatabase.$client.end());

const organizationId = "materials-test-org";
const at = new Date("2026-06-01T00:00:00.000Z");

/** A member who administers nothing. */
let learner!: Awaited<ReturnType<typeof signUp>>;
/** An admin of the organization. */
let teacher!: Awaited<ReturnType<typeof signUp>>;

/** A new account, signed in through the mounted Better Auth handler. */
async function signUp() {
  const email = `materials-test-${crypto.randomUUID()}@example.com`;
  return signInWithCode((path, init) => api.request(`/api/auth${path}`, init), outbox, { email });
}

/** A learner's answer, which carries the passages its task cites. */
function postAttempt(courseId: string, body: unknown, cookie: string) {
  return api.request(`/api/courses/${courseId}/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the materials routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    learner = await signUp();
    teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      adminIds: [teacher.id],
      at,
    });
  });

  /** The same app with somewhere to keep files, which `api` has not. */
  const filed = createApi({
    auth,
    database,
    baseUrl,
    files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-materials-files-"))),
  });

  /**
   * An S3-compatible bucket on this machine, as much of one as Bun's client
   * uses — PUT, HEAD, GET by path — so the bucket store runs for real.
   */
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const bucket = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(key, { bytes, type: request.headers.get("content-type") ?? "" });
        return new Response(null, { headers: { etag: '"stored"' } });
      }
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : object.bytes, {
        headers: { "content-type": object.type, "content-length": String(object.bytes.length) },
      });
    },
  });
  afterAll(() => bucket.stop(true));
  const bucketed = createApi({
    auth,
    database,
    baseUrl,
    files: bucketStore(
      new Bun.S3Client({
        bucket: "braivo",
        endpoint: bucket.url.origin,
        accessKeyId: "test",
        secretAccessKey: "test",
      }),
    ),
  });

  function postFile(body: string | Uint8Array, headers: Record<string, string>, app = filed) {
    return app.request(`/api/organizations/${organizationId}/files`, {
      method: "POST",
      headers,
      body,
    });
  }

  function getFile(fileId: string, cookie: string, app = filed) {
    return app.request(`/api/organizations/${organizationId}/files/${fileId}`, {
      headers: { cookie },
    });
  }

  test.each([
    ["a directory", filed],
    ["an S3-compatible bucket", bucketed],
  ])("keeps an uploaded file in %s, and gives it back only as a download", async (_label, app) => {
    const pdf = "%PDF-1.7 Mi primer libro";
    const uploaded = await postFile(
      pdf,
      { "content-type": "Application/PDF; name=libro.pdf", cookie: teacher.cookie },
      app,
    );

    expect(uploaded.status).toBe(201);
    const fileId = createHash("sha256").update(pdf).digest("hex");
    expect(await uploaded.json()).toEqual({ fileId, contentType: "application/pdf", size: 24 });

    const downloaded = await getFile(fileId, teacher.cookie, app);
    expect(downloaded.status).toBe(200);
    expect(Object.fromEntries(downloaded.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": "attachment",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(await downloaded.text()).toBe(pdf);
  });

  test("carries a renewed session's cookie on a download", async () => {
    // A download builds its own answer, which could leave the cookie out.
    const pdf = "%PDF-1.7 Renovado";
    const headers = { "content-type": "application/pdf", cookie: teacher.cookie };
    const { fileId } = (await (await postFile(pdf, headers)).json()) as { fileId: string };
    // Due for renewal, after the upload, so the download is what renews it.
    await database
      .update(session)
      .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(session.token, teacher.token));

    const downloaded = await getFile(fileId, teacher.cookie);

    expect(await downloaded.text()).toBe(pdf);
    const sent = teacher.cookie
      .split("; ")
      .find((pair) => pair.startsWith("better-auth.session_token="));
    const renewed = downloaded.headers.getSetCookie().map((set) => set.split(";", 1)[0]);
    expect(renewed).toContain(sent);
  });

  test("puts back bytes a store lost when the same file is uploaded again", async () => {
    const pdf = "%PDF-1.7 Perdido";
    const headers = { "content-type": "application/pdf", cookie: teacher.cookie };
    const { fileId } = (await (await postFile(pdf, headers)).json()) as { fileId: string };

    // Another, empty store, as after moving to a new bucket.
    const moved = createApi({
      auth,
      database,
      baseUrl,
      files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-materials-files-"))),
    });
    expect((await getFile(fileId, teacher.cookie, moved)).status).toBe(500);

    await postFile(pdf, headers, moved);
    expect(await (await getFile(fileId, teacher.cookie, moved)).text()).toBe(pdf);
  });

  test("takes the type the same bytes were last uploaded as, so a wrong one can be fixed", async () => {
    const pdf = "%PDF-1.7 Sin tipo";
    const as = (type: string) => postFile(pdf, { "content-type": type, cookie: teacher.cookie });
    const { fileId } = (await (await as("application/octet-stream")).json()) as {
      fileId: string;
    };

    expect(await (await as("application/pdf")).json()).toMatchObject({
      fileId,
      contentType: "application/pdf",
    });
    expect((await getFile(fileId, teacher.cookie)).headers.get("content-type")).toBe(
      "application/pdf",
    );
  });

  test.each([
    ["a form's content type", { "content-type": "multipart/form-data; boundary=x" }],
    ["text a page could send", { "content-type": "text/plain" }],
    ["no content type", {}],
    [
      "another site's origin",
      { "content-type": "application/pdf", origin: "https://evil.example" },
    ],
  ])("refuses an upload with %s, which a page elsewhere could make", async (_label, headers) => {
    const refused = await postFile("%PDF", { ...headers, cookie: teacher.cookie });

    expect(refused.status).toBe(403);
  });

  test("keeps files from a learner, who administers nothing", async () => {
    const pdf = { "content-type": "application/pdf" };
    const upload = await postFile("%PDF learner", { ...pdf, cookie: learner.cookie });
    expect(upload.status).toBe(403);

    const kept = await postFile("%PDF kept", { ...pdf, cookie: teacher.cookie });
    const { fileId } = (await kept.json()) as { fileId: string };
    expect((await getFile(fileId, learner.cookie)).status).toBe(403);
  });

  test.each([
    ["a file it does not have", "0".repeat(64)],
    ["what is not a file's ID", "../secrets"],
  ])("answers 404 for %s", async (_label, fileId) => {
    expect((await getFile(fileId, teacher.cookie)).status).toBe(404);
  });

  test("explains an upload it cannot keep", async () => {
    const empty = await postFile(new Uint8Array(), {
      "content-type": "application/pdf",
      cookie: teacher.cookie,
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "The file is empty." });

    const nowhere = await postFile(
      "%PDF",
      {
        "content-type": "application/pdf",
        cookie: teacher.cookie,
      },
      api,
    );
    expect(nowhere.status).toBe(501);
    expect(await nowhere.json()).toEqual({
      error: "This Braivo installation stores no files: its operator has not set BRAIVO_FILES.",
    });
  });

  function postSource(body: unknown, cookie: string, headers: Record<string, string> = {}) {
    return api.request(`/api/organizations/${organizationId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...headers },
      body: JSON.stringify(body),
    });
  }

  test("lets an admin add a source and read it back, in the documented shapes", async () => {
    const added = await postSource({ title: "Unidad 1", text: "Hola\r\nAdiós" }, teacher.cookie);
    const { sourceId } = (await added.json()) as { sourceId: string };

    const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
      headers: { cookie: teacher.cookie },
    });
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    const missing = await api.request(`/api/organizations/${organizationId}/sources/nope`, {
      headers: { cookie: teacher.cookie },
    });

    expect(added.status).toBe(201);
    expect(await listed.json()).toMatchObject({
      sources: expect.arrayContaining([
        { id: sourceId, title: "Unidad 1", createdAt: expect.any(String) },
      ]),
    });
    expect(await read.json()).toEqual({
      id: sourceId,
      title: "Unidad 1",
      text: "Hola\nAdiós",
      createdAt: expect.any(String),
    });
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(missing.status).toBe(404);
  });

  test("keeps a video's link and language beside its transcript", async () => {
    const added = await postSource(
      {
        title: "Los saludos",
        text: "Hola, ¿qué tal?",
        url: "https://www.youtube.com/watch?v=abc123",
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };

    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });

    expect(await read.json()).toEqual({
      id: sourceId,
      title: "Los saludos",
      text: "Hola, ¿qué tal?",
      url: "https://www.youtube.com/watch?v=abc123",
      language: "es",
      createdAt: expect.any(String),
    });
  });

  test("refuses sources it cannot or must not store", async () => {
    const source = { title: "Unidad 1", text: "Hola" };

    const refusals = [
      await postSource(source, learner.cookie),
      await postSource(source, teacher.cookie, { origin: "https://evil.example.com" }),
      await postSource({ title: "Unidad 1" }, teacher.cookie),
      await postSource({ ...source, text: "  " }, teacher.cookie),
      await postSource({ ...source, text: "x".repeat(10_000_001) }, teacher.cookie),
      await postSource({ ...source, url: null }, teacher.cookie),
      await postSource({ ...source, url: "file:///etc/passwd" }, teacher.cookie),
      await postSource({ ...source, language: 7 }, teacher.cookie),
    ];
    const listing = await api.request(`/api/organizations/${organizationId}/sources`, {
      headers: { cookie: learner.cookie },
    });

    expect(refusals.map((response) => response.status)).toEqual([
      403, 403, 400, 400, 413, 400, 400, 400,
    ]);
    expect(listing.status).toBe(403);
  });

  test("takes a learner to the moment of a video a passage is said at", async () => {
    const [animals] = await createObjectives(database, organizationId, ["Animals"]);
    const animalsCourse = await createCourse(database, {
      organizationId,
      title: "Animals",
      objectiveIds: [animals!],
    });
    const video = "https://www.youtube.com/watch?v=animales";

    // A video's captions rather than text: Braivo builds the transcript.
    const added = await postSource(
      {
        title: "Los animales",
        cues: [
          { at: 0, text: "Hola, amigos." },
          { at: 62.5, text: "El perro dice guau." },
        ],
        url: video,
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    expect(await read.json()).toMatchObject({
      text: "Hola, amigos.\nEl perro dice guau.",
      timing: [
        { start: 0, at: 0 },
        { start: 14, at: 62.5 },
      ],
    });

    const authored = await api.request(`/api/organizations/${organizationId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        tasks: [
          {
            objectiveId: animals,
            kind: "choice",
            prompt: "¿Qué dice el perro?",
            options: ["guau", "miau"],
            answer: 0,
            citations: [{ sourceId, quote: "El perro dice guau." }],
          },
        ],
      }),
    });
    const [taskId] = ((await authored.json()) as { taskIds: string[] }).taskIds;
    const answered = await postAttempt(
      animalsCourse,
      { id: crypto.randomUUID(), taskId, response: { choice: 1 } },
      learner.cookie,
    );

    expect(await answered.json()).toMatchObject({
      passages: [
        { quote: "El perro dice guau.", at: 62.5, source: { title: "Los animales", url: video } },
      ],
    });
  });

  test("tells a learner which page of their book a passage is on", async () => {
    const [colors] = await createObjectives(database, organizationId, ["Colors"]);
    const colorsCourse = await createCourse(database, {
      organizationId,
      title: "Colors",
      objectiveIds: [colors!],
    });

    // A book's pages rather than text, each labelled as printed.
    const added = await postSource(
      {
        title: "Mi primer libro",
        pages: [
          { page: "11", text: "Los colores" },
          { page: "12", text: "Rojo significa red." },
        ],
        language: "es",
      },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const read = await api.request(`/api/organizations/${organizationId}/sources/${sourceId}`, {
      headers: { cookie: teacher.cookie },
    });
    expect(await read.json()).toMatchObject({
      text: "Los colores\n\nRojo significa red.",
      pagination: [
        { start: 0, page: "11" },
        { start: 13, page: "12" },
      ],
    });

    const authored = await api.request(`/api/organizations/${organizationId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacher.cookie },
      body: JSON.stringify({
        tasks: [
          {
            objectiveId: colors,
            kind: "choice",
            prompt: "¿Qué significa rojo?",
            options: ["red", "blue"],
            answer: 0,
            citations: [{ sourceId, quote: "Rojo significa red." }],
          },
        ],
      }),
    });
    const [taskId] = ((await authored.json()) as { taskIds: string[] }).taskIds;
    const answered = await postAttempt(
      colorsCourse,
      { id: crypto.randomUUID(), taskId, response: { choice: 1 } },
      learner.cookie,
    );

    expect(await answered.json()).toMatchObject({
      passages: [
        { quote: "Rojo significa red.", page: "12", source: { title: "Mi primer libro" } },
      ],
    });
  });

  test.each([
    [
      "both cues and pages",
      { cues: [{ at: 0, text: "Hola" }], pages: [{ page: "1", text: "Hola" }] },
      undefined,
    ],
    ["a page numbered rather than labelled", { pages: [{ page: 1, text: "Hola" }] }, undefined],
    [
      "a page without words",
      { pages: [{ page: "1", text: " " }] },
      "Page 0 has no text Braivo can store: it is blank, or carries a NUL or an unpaired surrogate; leave out a page without words.",
    ],
  ])("refuses a document with %s", async (_label, body, error) => {
    const refused = await postSource({ title: "Book", ...body }, teacher.cookie);

    expect(refused.status).toBe(400);
    if (error === undefined) expect(await refused.text()).toBe("");
    else expect(await refused.json()).toEqual({ error });
  });

  test.each([
    ["both text and cues", { text: "Hola", cues: [{ at: 0, text: "Hola" }] }, undefined],
    ["a cue without a time", { cues: [{ text: "Hola" }] }, undefined],
    [
      "cues out of order",
      {
        cues: [
          { at: 5, text: "Hola" },
          { at: 1, text: "Adiós" },
        ],
      },
      "Cue 1 starts before the cue before it; send cues in order.",
    ],
  ])("refuses a transcript with %s", async (_label, body, error) => {
    const refused = await postSource({ title: "Transcript", ...body }, teacher.cookie);

    expect(refused.status).toBe(400);
    // Malformed bodies answer bare; a transcript refused for what it says explains.
    if (error === undefined) expect(await refused.text()).toBe("");
    else expect(await refused.json()).toEqual({ error });
  });

  test("drafts a course from a source with the installation's model, storing nothing", async () => {
    const added = await postSource(
      { title: "Saludos", text: "Hola significa hello." },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const asked: string[] = [];
    const model: Model = {
      answer: async ({ prompt }) => {
        asked.push(prompt);
        return {
          objectives: [
            {
              title: "Say hello",
              quotes: ["Hola significa hello."],
              tasks: [
                {
                  prompt: "Hello?",
                  options: ["Hola", "Adiós"],
                  answer: 0,
                  quotes: ["Hola significa hello."],
                },
                {
                  prompt: "Hola?",
                  options: ["Hello", "Goodbye"],
                  answer: 0,
                  quotes: ["Hola significa hola."],
                },
              ],
            },
          ],
        };
      },
    };
    const drafting = createApi({
      auth,
      database,
      cachedDatabase,
      baseUrl,
      ai: { model, organizations: new Set([organizationId]) },
    });
    const draft = (source: string, cookie: string, body: object = {}, app = drafting) =>
      app.request(`/api/organizations/${organizationId}/sources/${source}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    cachedStatements.length = 0;
    const drafted = await draft(sourceId, teacher.cookie, { audience: "grade 2" });
    expect(drafted.status).toBe(200);
    // The source alone comes through the cache; who may draft, and the quota
    // charged, never do.
    expect(cachedStatements).toEqual([expect.stringMatching(/ from "source" /)]);
    expect(await drafted.json()).toEqual({
      objectives: [
        {
          key: expect.any(String),
          title: "Say hello",
          citations: [{ sourceId, quote: "Hola significa hello." }],
          tasks: [
            {
              kind: "choice",
              prompt: "Hello?",
              options: ["Hola", "Adiós"],
              answer: 0,
              citations: [{ sourceId, quote: "Hola significa hello." }],
            },
          ],
        },
      ],
      refused: [
        "Objective “Say hello”, task “Hola?”: the quote “Hola significa hola.” does not occur in the source.",
        "Objective “Say hello”, task “Hola?”: none of its quotes was found in the source.",
      ],
    });
    expect(asked[0]).toContain("Learners: grade 2.");

    // Served by Bun, the request is let wait for the model past Bun's idle timeout.
    const timeout = vi.fn();
    await drafting.request(
      `/api/organizations/${organizationId}/sources/${sourceId}/draft`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      },
      { timeout },
    );
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);

    // Nobody but an administrator spends the installation's model.
    cachedStatements.length = 0;
    expect((await draft(sourceId, learner.cookie)).status).toBe(403);
    expect(cachedStatements).toEqual([]);
    expect((await draft(crypto.randomUUID(), teacher.cookie)).status).toBe(404);
    const long = await draft(sourceId, teacher.cookie, { audience: "a".repeat(201) });
    expect(long.status).toBe(400);
    // Owning an organization is not the operator's leave to spend on it.
    const elsewhere = createApi({
      auth,
      database,
      baseUrl,
      ai: { model, organizations: new Set(["another-org"]) },
    });
    const refused = await draft(sourceId, teacher.cookie, {}, elsewhere);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("ask its operator");
    expect(asked).toHaveLength(2);
  });

  test("reads a PDF's text, page by page, for an organization the operator lets", async () => {
    const files = directoryStore(mkdtempSync(join(tmpdir(), "braivo-materials-files-")));
    const model: Model = {
      answer: async ({ files: read }) => ({
        pages: [{ page: "1", text: `Leído: ${new TextDecoder().decode(read?.[0]?.bytes)}` }],
      }),
    };
    const reading = createApi({
      auth,
      database,
      baseUrl,
      files,
      ai: { model, organizations: new Set([organizationId]) },
    });
    const upload = async (body: string | Uint8Array, type: string) => {
      const uploaded = await postFile(
        body,
        { "content-type": type, cookie: teacher.cookie },
        reading,
      );
      return ((await uploaded.json()) as { fileId: string }).fileId;
    };
    const read = (fileId: string, app = reading) =>
      app.request(`/api/organizations/${organizationId}/files/${fileId}/text`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    const pdf = await upload("%PDF-1.7 Hola", "application/pdf");
    const answered = await read(pdf);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ pages: [{ page: "1", text: "Leído: %PDF-1.7 Hola" }] });

    const epub = await upload("PK epub", "application/epub+zip");
    const refused = await read(epub);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("reads PDFs and images");
    // Printable: the model here answers them back as a page's text, which may hold no NUL.
    const bytes = (size: number) => new Uint8Array(size).fill(97);
    expect((await read(await upload(bytes(7_500_000), "image/png"))).status).toBe(200);
    const photo = await read(await upload(bytes(7_500_001), "image/png"));
    expect(photo.status).toBe(400);
    expect(await photo.json()).toEqual({
      error:
        "Braivo's AI reads an image of at most 7.5 MB; photograph a page at a time, or save it smaller.",
    });
    const book = await read(await upload(bytes(24_000_001), "application/pdf"));
    expect(book.status).toBe(400);
    expect(await book.json()).toEqual({
      error: "Braivo's AI reads a PDF of at most 24 MB; send it a chapter at a time.",
    });
    expect((await read("0".repeat(64))).status).toBe(404);
    // No file store: nothing to read from, said as for uploading.
    expect(
      (await read(pdf, createApi({ auth, database, baseUrl, ai: { model, organizations: "all" } })))
        .status,
    ).toBe(501);
  });

  test("stops an organization at its month's AI requests, counting only those asked", async () => {
    // An organization of its own, so no other test's requests count against it.
    const limitedOrganization = "materials-test-limited-org";
    await testing.seedOrganization(database, {
      organizationId: limitedOrganization,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });
    const add = async (text: string) => {
      const added = await api.request(`/api/organizations/${limitedOrganization}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify({ title: "Saludos", text }),
      });
      return ((await added.json()) as { sourceId: string }).sourceId;
    };
    const sourceId = await add("Hola significa hello.");
    let asked = 0;
    const limited = createApi({
      auth,
      database,
      baseUrl,
      ai: {
        model: {
          answer: async () => {
            asked += 1;
            if (asked === 1) throw new ModelUnavailable("The model answered 529.");
            return { objectives: [] };
          },
        },
        organizations: "all",
        monthlyLimit: 2,
      },
    });
    const draft = (source: string, body: object = {}) =>
      limited.request(`/api/organizations/${limitedOrganization}/sources/${source}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: JSON.stringify(body),
      });

    // Refused before the model is asked, so they cost nothing.
    expect((await draft(sourceId, { audience: "a".repeat(201) })).status).toBe(400);
    const long = await draft(await add("a".repeat(200_001)));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({
      error:
        "The source is longer than 200,000 characters; add it as several sources, a chapter each, and draft from each.",
    });
    // Asked and failed, so it may have been paid for: it counts.
    expect((await draft(sourceId)).status).toBe(502);
    expect((await draft(sourceId)).status).toBe(200);

    const refused = await draft(sourceId);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /^This organization has reached its monthly AI limit \(2\)\. You can use Braivo's AI again from \d{4}-\d{2}-01; meanwhile, use your own desktop agent through braivo mcp\.$/,
    );
    expect(asked).toBe(2);
  });

  test("charges nothing for a file the store failed to give", async () => {
    const readOrganization = "materials-test-read-org";
    await testing.seedOrganization(database, {
      organizationId: readOrganization,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });
    const store = directoryStore(mkdtempSync(join(tmpdir(), "braivo-materials-files-")));
    let failing = false;
    const reading = createApi({
      auth,
      database,
      baseUrl,
      files: {
        put: (key, bytes, type) => store.put(key, bytes, type),
        // As a bucket's lazy file does: found, and then failing to download.
        get: async (key) =>
          failing
            ? ({ arrayBuffer: () => Promise.reject(new Error("download failed")) } as Blob)
            : store.get(key),
      },
      ai: {
        model: { answer: async () => ({ pages: [{ page: "1", text: "Hola." }] }) },
        organizations: "all",
        monthlyLimit: 1,
      },
    });
    const uploaded = await reading.request(`/api/organizations/${readOrganization}/files`, {
      method: "POST",
      headers: { "content-type": "application/pdf", cookie: teacher.cookie },
      body: "%PDF-1.7 Hola",
    });
    const { fileId } = (await uploaded.json()) as { fileId: string };
    const read = () =>
      reading.request(`/api/organizations/${readOrganization}/files/${fileId}/text`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    failing = true;
    expect((await read()).status).toBe(500);
    failing = false;
    // The month's one request is still there to use.
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(429);
  });

  test("says why it cannot draft: no model, or a model that failed", async () => {
    const added = await postSource(
      { title: "Saludos", text: "Hola significa hello." },
      teacher.cookie,
    );
    const { sourceId } = (await added.json()) as { sourceId: string };
    const failing = createApi({
      auth,
      database,
      baseUrl,
      ai: {
        model: {
          answer: async () => {
            throw new ModelUnavailable("The model answered 529.");
          },
        },
        organizations: "all",
      },
    });
    const draft = (app: typeof api) =>
      app.request(`/api/organizations/${organizationId}/sources/${sourceId}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacher.cookie },
        body: "{}",
      });

    const none = await draft(api);
    expect(none.status).toBe(501);
    expect(((await none.json()) as { error: string }).error).toContain("braivo mcp");
    const failed = await draft(failing);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "The model answered 529." });
  });
});
