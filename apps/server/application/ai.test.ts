// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The AI ledger (generation-10, generation-11): each request reserved before the
// model is asked, and completed with its model, prompt version, outcome, and
// counts, through the use cases that ask it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "@braivo/db";
import { runMigrations } from "@braivo/db";
import { aiRequest } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DRAFT_OPERATION } from "../ai/draft.ts";
import { READ_OPERATION } from "../ai/extract.ts";
import { anthropicModel, type Model, ModelUnavailable } from "../ai/index.ts";
import { promptVersion } from "../ai/operation.ts";
import { createSource, recordFile } from "../persistence/index.ts";
import { directoryStore } from "../storage/index.ts";
import { type Ai, AiLimitReached } from "./ai.ts";
import { draftFromSource } from "./drafts.ts";
import { readFileText } from "./files.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "ai-ledger-test-org";
const teacherId = "ai-ledger-test-teacher";
const now = new Date("2026-09-10T00:00:00.000Z");
const fileId = "a".repeat(64);
const files = directoryStore(mkdtempSync(join(tmpdir(), "braivo-ai-ledger-")));

let sourceId!: string;
const text = "Rojo significa red.\nAzul significa blue.\nRojo y azul.";

/** A model, not the default one, answering `answer` however it is asked. */
const answering = (answer: () => unknown): Model => ({
  id: "claude-opus-test",
  answer: async () => answer(),
});

const ai = (model: Model, monthlyLimit?: number): Ai => ({
  model,
  organizations: "all",
  ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
});

const draft = (model: Ai, options: { signal?: AbortSignal; database?: Database } = {}) =>
  draftFromSource({
    database: options.database ?? database,
    cachedDatabase: database,
    ai: model,
    organizationId,
    actingAs: teacherId,
    sourceId,
    now,
    signal: options.signal,
  });

const read = (model: Ai, signal?: AbortSignal) =>
  readFileText({
    database,
    ai: model,
    files,
    organizationId,
    actingAs: teacherId,
    fileId,
    now,
    signal,
  });

const ledger = () =>
  database
    .select()
    .from(aiRequest)
    .where(eq(aiRequest.organizationId, organizationId))
    .orderBy(asc(aiRequest.createdAt), asc(aiRequest.completedAt));

/** Anthropic's adapter over `fetch`, as production asks the model. */
const anthropic = (fetch: (signal: AbortSignal) => Promise<Response>): Model =>
  anthropicModel({
    apiKey: "key",
    model: "claude-sonnet-5",
    fetch: ((_url: string, init: RequestInit) => fetch(init.signal!)) as typeof globalThis.fetch,
  });

/** Settles when `signal` aborts, rejecting as fetch does with its reason. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Requires TEST_DATABASE_URL: the point is what the ledger keeps. */
describe.skipIf(!connectionString)("the AI ledger", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [teacherId],
      at: now,
    });
    sourceId = await createSource(database, {
      organizationId,
      title: "Los colores",
      text,
      language: "es",
      createdAt: now,
    });
    await files.put(
      `organizations/${organizationId}/files/${fileId}`,
      new TextEncoder().encode("%PDF-1.7"),
      "application/pdf",
    );
    await recordFile(database, {
      organizationId,
      sha256: fileId,
      contentType: "application/pdf",
      size: 8,
      createdAt: now,
    });
  });

  test("records a draft's model, prompt version, and counts, as validation took them", async () => {
    const task = (prompt: string, quotes: string[]) => ({
      kind: "choice",
      prompt,
      options: ["red", "blue"],
      answer: 0,
      quotes,
    });
    // Hand-counted: 3 objectives and 3 tasks proposed; "Red" keeps 1 of 2
    // tasks, "Blue" is kept with its 1, "Rojo" keeps none.
    const drafted = await draft(
      ai(
        answering(() => ({
          coverage: "all",
          missing: null,
          objectives: [
            {
              title: "Red",
              quotes: ["Rojo significa red."],
              tasks: [task("¿Rojo?", ["Rojo significa red."]), task("¿Y?", ["Verde."])],
            },
            {
              title: "Blue",
              quotes: ["Azul significa blue."],
              tasks: [task("¿Azul?", ["Azul significa blue."])],
            },
            { title: "Rojo", quotes: ["Rojo"], tasks: [] },
          ],
        })),
      ),
    );

    expect(drafted?.objectives.map(({ title }) => title)).toEqual(["Red", "Blue"]);
    expect(await ledger()).toEqual([
      {
        id: expect.any(String),
        organizationId,
        kind: "draft",
        userId: teacherId,
        createdAt: now,
        model: "claude-opus-test",
        promptVersion: promptVersion(DRAFT_OPERATION),
        outcome: "succeeded",
        failure: null,
        counts: {
          proposed: { objectives: 3, tasks: 3 },
          kept: { objectives: 2, tasks: 2 },
          refusals: {
            "quote-missing": 1,
            "task-without-quote": 1,
            "quote-ambiguous": 1,
            "objective-without-quote": 1,
          },
        },
        completedAt: expect.any(Date),
      },
    ]);
    expect(drafted?.refused).toHaveLength(4);
  });

  test("records a reading's pages, a blank entry it returned counted apart", async () => {
    const pages = await read(
      ai(
        answering(() => ({
          pages: [
            { page: "1", text: "Hola." },
            { page: "2", text: " " },
          ],
        })),
      ),
    );

    expect(pages).toEqual([{ page: "1", text: "Hola." }]);
    expect(await ledger()).toMatchObject([
      {
        kind: "read",
        model: "claude-opus-test",
        promptVersion: promptVersion(READ_OPERATION),
        outcome: "succeeded",
        counts: { pages: 1, blankEntries: 1 },
      },
    ]);
  });

  test.each([
    [
      "while waiting for an answer",
      (signal: AbortSignal, leave: () => void) => {
        setTimeout(leave);
        return aborted(signal);
      },
    ],
    [
      "while reading the answer",
      async (signal: AbortSignal, leave: () => void) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"content": ['));
              signal.addEventListener("abort", () => controller.error(signal.reason));
              setTimeout(leave);
            },
          }),
        ),
    ],
  ])("records an abort %s as aborted", async (_label, fetch) => {
    const ask = async (asking: (model: Ai, signal: AbortSignal) => Promise<unknown>) => {
      const left = new AbortController();
      const model = anthropic((signal) => fetch(signal, () => left.abort()));
      await expect(asking(ai(model), left.signal)).rejects.toThrow();
    };

    await ask((model, signal) => draft(model, { signal }));
    await ask((model, signal) => read(model, signal));

    expect(await ledger()).toMatchObject([
      { kind: "draft", model: "claude-sonnet-5", outcome: "aborted", failure: null, counts: null },
      { kind: "read", model: "claude-sonnet-5", outcome: "aborted", failure: null, counts: null },
    ]);
  });

  test.each([
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
    ["provider-error", async () => new Response("{}", { status: 529 })],
    [
      "timeout",
      async () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    ],
    [
      "cut-short",
      async () => Response.json({ stop_reason: "max_tokens", content: [] }, { status: 200 }),
    ],
  ])("records a provider's failure by its kind, %s", async (failure, fetch) => {
    await expect(draft(ai(anthropic(fetch)))).rejects.toThrow();

    expect(await ledger()).toMatchObject([{ outcome: "failed", failure, counts: null }]);
  });

  test("records a failure after the model answered by what was wrong with the answer", async () => {
    await expect(draft(ai(answering(() => ({ courses: [] }))))).rejects.toThrow();
    await expect(
      read(ai(answering(() => ({ pages: [{ page: "", text: "Hola" }] })))),
    ).rejects.toThrow();
    await expect(read(ai(answering(() => ({ pages: [] }))))).rejects.toThrow();
    await expect(
      draft(
        ai(
          answering(() => {
            throw new TypeError("a bug, not the model");
          }),
        ),
      ),
    ).rejects.toThrow("a bug");

    expect((await ledger()).map(({ kind, outcome, failure }) => [kind, outcome, failure])).toEqual([
      ["draft", "failed", "wrong-shape"],
      ["read", "failed", "invalid-output"],
      ["read", "failed", "no-words"],
      ["draft", "failed", "error"],
    ]);
  });

  test("keeps the answer when completing fails, the row left unknown and still counted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The reservation commits; the completion's update fails.
    const failingUpdates = new Proxy(database, {
      get: (target, property, receiver) =>
        property === "update"
          ? () => {
              throw new Error("connection lost");
            }
          : Reflect.get(target, property, receiver),
    });
    const model = ai(
      answering(() => ({ coverage: "all", missing: null, objectives: [] })),
      1,
    );

    expect(await draft(model, { database: failingUpdates })).toEqual({
      objectives: [],
      refused: [],
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Error"));
    error.mockRestore();

    expect(await ledger()).toMatchObject([{ outcome: "unknown", completedAt: null }]);
    await expect(draft(model)).rejects.toBeInstanceOf(AiLimitReached);
  });

  test("answers within the completion's wait when completing stalls, the row left unknown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The reservation commits; the completion's update never settles.
    const stalledUpdates = new Proxy(database, {
      get: (target, property, receiver) =>
        property === "update"
          ? () => ({ set: () => ({ where: () => new Promise(() => {}) }) })
          : Reflect.get(target, property, receiver),
    });
    const answered = ai(
      answering(() => ({ coverage: "all", missing: null, objectives: [] })),
      2,
    );
    const failing = ai({
      id: "claude-opus-test",
      answer: async () => {
        throw new ModelUnavailable("unreachable", "down");
      },
    });

    const started = Date.now();
    expect(await draft(answered, { database: stalledUpdates })).toEqual({
      objectives: [],
      refused: [],
    });
    await expect(draft(failing, { database: stalledUpdates })).rejects.toBeInstanceOf(
      ModelUnavailable,
    );
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("answering without it"));
    error.mockRestore();

    expect((await ledger()).map(({ outcome }) => outcome)).toEqual(["unknown", "unknown"]);
    await expect(draft(answered)).rejects.toBeInstanceOf(AiLimitReached);
  }, 10_000);

  test("gives the month's last request to one of two racing, and completes it", async () => {
    const model = ai(
      answering(() => ({ coverage: "all", missing: null, objectives: [] })),
      1,
    );

    const raced = await Promise.allSettled([draft(model), draft(model)]);

    expect(raced.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(raced.find((settled) => settled.status === "rejected")).toMatchObject({
      reason: expect.any(AiLimitReached),
    });
    expect(await ledger()).toMatchObject([{ outcome: "succeeded" }]);
  });
});
