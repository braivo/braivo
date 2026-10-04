// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import type { Model } from "../ai/index.ts";
import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { directoryStore } from "../storage/index.ts";
import { createApi } from "./app.ts";
import { createClient } from "./client.ts";

// "Upload your existing materials and get a tutor", whole: a PDF uploaded,
// read into pages, drafted into a course, accepted, and answered by a learner,
// who is shown the page of the book the question came from — through the real
// app and the client the console uses, with only the model stood in for. Each
// step's shape is tested where it is made; this is what holds them together:
// a draft is only as good as the authoring endpoints' willingness to take it.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const baseUrl = "http://localhost:3000";
const organizationId = "materials-test-org";

const book = "%PDF-1.7 Mi primer libro";
const page12 = "Hola significa hello.\nAdiós significa goodbye.";

/** A model that reads the book above, and drafts from it, as a real one would. */
const model: Model = {
  answer: async ({ name, files }) => {
    if (name === "transcribe") {
      expect(new TextDecoder().decode(files?.[0]?.bytes)).toBe(book);
      return { pages: [{ page: "12", text: page12 }] };
    }
    return {
      objectives: [
        {
          title: "Say hello",
          quotes: ["Hola significa hello."],
          tasks: [
            {
              prompt: "How do you say hello?",
              options: ["Hola", "Adiós"],
              answer: 0,
              explanation: "Adiós is goodbye.",
              quotes: ["Hola significa hello."],
            },
          ],
        },
        {
          title: "Say goodbye",
          quotes: ["Adiós significa goodbye."],
          tasks: [
            {
              prompt: "How do you say goodbye?",
              options: ["Adiós", "Hola"],
              answer: 0,
              quotes: ["Adiós significa goodbye."],
            },
          ],
        },
      ],
    };
  },
};

const outbox = createOutbox();
const auth = createAuth({
  database,
  secret: "materials-test-secret-long-enough-32",
  baseURL: baseUrl,
  sendMail: outbox.sendMail,
});
const api = createApi({
  auth,
  database,
  baseUrl,
  files: directoryStore(mkdtempSync(join(tmpdir(), "braivo-materials-"))),
  ai: { model, organizations: new Set([organizationId]) },
});

/**
 * What each JSON write answered forged as `text/plain`, which a page elsewhere
 * may post unasked, before it is sent as it was.
 */
const forged: string[] = [];
const client = createClient({
  fetch: (async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("content-type") === "application/json") {
      headers.set("content-type", "text/plain");
      const answer = await api.request(path, { ...init, headers });
      forged.push(`${answer.status} ${path.split("/").at(-1)}`);
    }
    return api.request(path, init);
  }) as unknown as typeof globalThis.fetch,
});

async function signUp(): Promise<{ headers: { cookie: string }; id: string }> {
  const email = `materials-${crypto.randomUUID()}@example.com`;
  const { cookie, id } = await signInWithCode(
    (path, init) => api.request(`/api/auth${path}`, init),
    outbox,
    { email, name: email },
  );
  return { headers: { cookie }, id };
}

let teacher!: Awaited<ReturnType<typeof signUp>>;
let learner!: Awaited<ReturnType<typeof signUp>>;

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("from a teacher's PDF to a tutor", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    learner = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      adminIds: [teacher.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
  });

  test("uploads, reads, drafts, accepts, and teaches from the page it came from", async () => {
    const pdf = new Blob([book], { type: "application/pdf" });
    const { fileId } = await client.uploadFile({ organizationId, file: pdf }, teacher);
    const pages = await client.readFileText({ organizationId, fileId }, teacher);
    const sourceId = await client.addSource(
      { organizationId, title: "Mi primer libro", pages, language: "es", original: fileId },
      teacher,
    );

    const draft = await client.draftCourse(
      { organizationId, sourceId, audience: "grade 2, English speakers" },
      teacher,
    );
    expect(draft.refused).toEqual([]);
    const accepting = { organizationId, sourceId, title: "Saludos", objectives: draft.objectives };
    const courseId = await client.acceptDraft(accepting, teacher);
    // Accepting again, as after a lost answer, is the same course; keeping
    // less of the draft is another.
    expect(await client.acceptDraft(accepting, teacher)).toBe(courseId);
    const smaller = { ...accepting, objectives: draft.objectives.slice(0, 1) };
    expect(await client.acceptDraft(smaller, teacher)).not.toBe(courseId);

    const course = await client.readCourse({ organizationId, courseId }, teacher);
    expect(course.objectives.map(({ title, tasks }) => [title, tasks.length])).toEqual([
      ["Say hello", 1],
      ["Say goodbye", 1],
    ]);

    // The learner meets the first objective, answers wrongly, and is sent to
    // page 12 of the book the teacher uploaded.
    const activity = await client.nextActivity(courseId, learner);
    expect(activity?.objective.title).toBe("Say hello");
    if (!activity || !("task" in activity)) throw new Error("No task to answer.");
    const wrong = activity.task.options.find(({ text }) => text === "Adiós")!;
    const grade = await client.submitAttempt(
      {
        courseId,
        id: crypto.randomUUID(),
        taskId: activity.task.id,
        response: { choice: wrong.choice },
      },
      learner,
    );

    expect(grade).toMatchObject({
      outcome: "failure",
      explanation: "Adiós is goodbye.",
      passages: [
        { quote: "Hola significa hello.", page: "12", source: { title: "Mi primer libro" } },
      ],
    });
    // Refused, while the same write as JSON went on to do all of the above.
    expect(new Set(forged)).toEqual(
      new Set(
        ["text", "sources", "draft", "objectives", "citations", "tasks", "courses", "attempts"].map(
          (route) => `403 ${route}`,
        ),
      ),
    );
  });
});
