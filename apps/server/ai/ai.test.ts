// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { draftCourse } from "./draft.ts";
import { extractPages } from "./extract.ts";
import { anthropicModel, type Model, ModelUnavailable } from "./model.ts";

const source = {
  id: "8c1f2d3e-0000-4000-8000-000000000001",
  title: "Los colores",
  text: "Rojo significa red.\nAzul significa blue.\nRojo y azul.",
  language: "es",
};

/** A model that answers `answer`, and remembers what it was asked. */
function answering(answer: unknown) {
  const asked: Parameters<Model["answer"]>[0][] = [];
  const model: Model = {
    answer: async (request) => {
      asked.push(request);
      return answer;
    },
  };
  return { model, asked };
}

const task = (prompt: string, answer: number, quotes: string[]) => ({
  prompt,
  options: ["red", "blue"],
  answer,
  explanation: "",
  quotes,
});

describe("drafting a course from a source", () => {
  test("keeps what Braivo would accept, in the shapes its endpoints take", async () => {
    const { model, asked } = answering({
      objectives: [
        {
          title: " Red ",
          quotes: ["Rojo  significa\nred."],
          tasks: [task("¿Rojo?", 0, ["Rojo significa red."])],
        },
      ],
    });

    const draft = await draftCourse(model, source, { audience: "grade 2, English speakers" });

    expect(draft).toEqual({
      objectives: [
        {
          key: expect.stringMatching(/^[0-9a-f-]{36}$/),
          title: "Red",
          // As the model wrote it: the endpoints locate it again, loosely.
          citations: [{ sourceId: source.id, quote: "Rojo  significa\nred." }],
          tasks: [
            {
              kind: "choice",
              prompt: "¿Rojo?",
              options: ["red", "blue"],
              answer: 0,
              citations: [{ sourceId: source.id, quote: "Rojo significa red." }],
            },
          ],
        },
      ],
      refused: [],
    });
    expect(asked[0]?.prompt).toContain("Learners: grade 2, English speakers.");
    expect(asked[0]?.prompt).toContain(source.text);
    expect(asked[0]?.schema).toMatchObject({ type: "object", required: ["objectives"] });
  });

  test("refuses, by name, what it cannot find or cannot keep", async () => {
    const { model } = answering({
      objectives: [
        {
          title: "Red",
          quotes: ["Rojo significa rojo.", "Rojo", "Rojo significa red."],
          tasks: [
            task("¿Rojo?", 5, ["Rojo significa red."]),
            task(" ", 0, ["Rojo significa red."]),
            task("¿Azul?", 1, ["Azul es azul."]),
            task("¿Red?", 0, ["Rojo significa red."]),
          ],
        },
        { title: "  ", quotes: ["Rojo y azul."], tasks: [task("¿Y?", 0, ["Rojo y azul."])] },
        { title: "Blue", quotes: ["Azul significa blue."], tasks: [] },
        { title: "Both", quotes: ["Azul y\n  rojo."], tasks: [task("¿Y?", 0, ["Rojo y azul."])] },
      ],
    });

    const draft = await draftCourse(model, source);

    expect(draft.objectives).toMatchObject([
      {
        title: "Red",
        citations: [{ quote: "Rojo significa red." }],
        tasks: [{ prompt: "¿Red?", citations: [{ quote: "Rojo significa red." }] }],
      },
    ]);
    // By name, not place: the owner reviews only what was kept, numbered anew.
    expect(draft.refused).toEqual([
      "Objective “Red”, task “¿Rojo?”: the task needs its answer to be the index of the correct option, a whole number from 0 to 1.",
      "Objective “Red”, a task without a question: the task has a prompt that is blank.",
      "Objective “Red”, task “¿Azul?”: the quote “Azul es azul.” does not occur in the source.",
      "Objective “Red”, task “¿Azul?”: none of its quotes was found in the source.",
      "Objective “Red”: the quote “Rojo significa rojo.” does not occur in the source.",
      "Objective “Red”: the quote “Rojo” occurs more than once in the source; quote more of it.",
      "An untitled objective: its title is blank or over 500 characters.",
      "Objective “Blue”: none of its tasks was kept.",
      "Objective “Both”: the quote “Azul y rojo.” does not occur in the source.",
      "Objective “Both”: none of its quotes was found in the source.",
    ]);
  });

  test("makes each objective a key of its own, so another draft makes others", async () => {
    const answer = {
      objectives: [
        { title: "Red", quotes: ["Rojo y azul."], tasks: [task("¿Y?", 0, ["Rojo y azul."])] },
      ],
    };

    const [first, second] = await Promise.all([
      draftCourse(answering(answer).model, source),
      draftCourse(answering(answer).model, source),
    ]);

    expect(first.objectives[0]!.key).not.toBe(second.objectives[0]!.key);
  });

  test("keeps a whole draft within what one authoring request takes", async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `Línea ${index}.`);
    const objective = {
      title: "Lines",
      quotes: lines,
      tasks: Array.from({ length: 6 }, (_, index) => task(`¿Línea ${index}?`, 0, lines)),
    };
    const { model } = answering({
      objectives: Array.from({ length: 14 }, (_, index) =>
        index < 12 ? objective : { ...objective, title: `Lines ${index + 1}` },
      ),
    });

    const draft = await draftCourse(model, { ...source, text: lines.join("\n") });

    // Accepting sends every objective quote in one request, and every task
    // quote in another, each at most 200.
    const tasks = draft.objectives.flatMap((kept) => kept.tasks);
    expect(draft.objectives).toHaveLength(12);
    expect(draft.objectives.flatMap((kept) => kept.citations).length).toBeLessThanOrEqual(200);
    expect(tasks.flatMap((kept) => kept.citations).length).toBeLessThanOrEqual(200);
    expect(draft.refused).toContain("Objective “Lines”: only its first 5 quotes are read.");
    expect(draft.refused).toContain(
      "Objective “Lines”, task “¿Línea 0?”: only its first 3 quotes are read.",
    );
    // Each past the cap, by its own title.
    expect(draft.refused).toContain("Objective “Lines 13”: more than 12 objectives were drafted.");
    expect(draft.refused).toContain("Objective “Lines 14”: more than 12 objectives were drafted.");
    expect(draft.refused).toContain(
      "Objective “Lines”, task “¿Línea 5?”: more than 5 tasks were drafted.",
    );
  });

  test("refuses a title the objective endpoint would", async () => {
    const { model } = answering({
      objectives: [
        {
          // Over 500, with an emoji as the 79th code point, which a cut by UTF-16 units would split.
          title: `${"T".repeat(78)}😀${"T".repeat(422)}`,
          quotes: ["Rojo y azul."],
          tasks: [task("¿Y?", 0, ["Rojo y azul."])],
        },
      ],
    });

    const draft = await draftCourse(model, source);

    expect(draft.objectives).toEqual([]);
    // Named, cut short, as the owner never saw it.
    expect(draft.refused).toEqual([
      `Objective “${"T".repeat(78)}😀…”: its title is blank or over 500 characters.`,
    ]);
  });

  test("says the model failed when it answers in another shape", async () => {
    await expect(draftCourse(answering({ courses: [] }).model, source)).rejects.toBeInstanceOf(
      ModelUnavailable,
    );
  });
});

describe("reading a file's text", () => {
  const pdf = { mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") };

  test("sends the file, and keeps the pages that have words", async () => {
    const { model, asked } = answering({
      pages: [
        { page: "i", text: "Índice" },
        { page: "2", text: "  " },
        { page: "3", text: "Hola significa hello." },
      ],
    });

    expect(await extractPages(model, pdf)).toEqual([
      { page: "i", text: "Índice" },
      { page: "3", text: "Hola significa hello." },
    ]);
    expect(asked[0]?.files).toEqual([pdf]);
  });

  test.each([
    ["no words at all", { pages: [{ page: "1", text: " " }] }, "found no words"],
    ["a page no source can have", { pages: [{ page: "", text: "Hola" }] }, "Page 0 needs `page`"],
    ["another shape", { text: "Hola" }, "shape asked for"],
  ])("says the model failed when it answers %s", async (_label, answer, message) => {
    await expect(extractPages(answering(answer).model, pdf)).rejects.toThrow(message);
  });
});

describe("Anthropic's Messages API", () => {
  function replying(status: number, body: unknown) {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent };
  }

  const request = {
    system: "Be brief.",
    prompt: "Draft.",
    name: "draft_course",
    description: "Proposes.",
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
  };

  test("forces the answer as a call to one tool, and reads its input", async () => {
    const { fetch, sent } = replying(200, {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Here it is." },
        { type: "tool_use", name: "draft_course", input: { objectives: [] } },
      ],
    });

    const answer = await anthropicModel({ apiKey: "key", model: "claude-sonnet-5", fetch }).answer(
      request,
    );

    expect(answer).toEqual({ objectives: [] });
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.init.headers).toMatchObject({ "x-api-key": "key" });
    expect(JSON.parse(sent[0]!.init.body as string)).toMatchObject({
      model: "claude-sonnet-5",
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "text", text: "Draft." }] }],
      tools: [{ name: "draft_course", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "draft_course" },
    });
    expect(JSON.parse(sent[0]!.init.body as string).tools[0].input_schema.$schema).toBeUndefined();
  });

  test("stops asking when whoever asked has gone", async () => {
    const left = new AbortController();
    let signal: AbortSignal | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      left.abort();
      signal?.throwIfAborted();
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      anthropicModel({ apiKey: "key", model: "claude-sonnet-5", fetch }).answer({
        ...request,
        signal: left.signal,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailable);
    expect(signal?.aborted).toBe(true);
  });

  test("sends a PDF as a document and a photo as an image, before the prompt", async () => {
    const { fetch, sent } = replying(200, {
      content: [{ type: "tool_use", name: "draft_course", input: {} }],
    });

    await anthropicModel({ apiKey: "key", model: "claude-sonnet-5", fetch }).answer({
      ...request,
      files: [
        { mediaType: "application/pdf", bytes: new Uint8Array([1, 2]) },
        { mediaType: "image/png", bytes: new Uint8Array([3]) },
      ],
    });

    expect(JSON.parse(sent[0]!.init.body as string).messages[0].content).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AQI=" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "Aw==" } },
      { type: "text", text: "Draft." },
    ]);
  });

  test.each([
    ["an error status", replying(529, { error: "overloaded" }), "answered 529"],
    ["an answer cut short", replying(200, { stop_reason: "max_tokens", content: [] }), "cut short"],
    ["no call of the tool", replying(200, { content: [{ type: "text", text: "No." }] }), "shape"],
    ["no message", replying(200, null), "shape"],
    ["content that is no list", replying(200, { content: {} }), "shape"],
    ["a null content block", replying(200, { content: [null] }), "shape"],
  ])("fails as unavailable on %s", async (_label, { fetch }, message) => {
    const model = anthropicModel({ apiKey: "key", model: "claude-sonnet-5", fetch });

    // The class, not just the words: only a `ModelUnavailable` becomes the explained 502.
    const answer = model.answer(request);
    await expect(answer).rejects.toBeInstanceOf(ModelUnavailable);
    await expect(answer).rejects.toThrow(message);
  });
});
