// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import {
  normalizeAnswer,
  gradeResponse,
  parseTaskBody,
  parseTaskResponse,
  type PresentedTask,
  presentTask,
  type TaskBody,
} from "./task.ts";

/** A presented choice task's options; anything else fails the test. */
function optionsOf(task: PresentedTask) {
  if (task.kind !== "choice") throw new Error(`Expected a choice task, got "${task.kind}".`);
  return task.options;
}

const choice: TaskBody = {
  kind: "choice",
  prompt: "Past tense of 'hablar', first person?",
  options: ["hablé", "hablo"],
  answer: 0,
  explanation: "Preterite, first person singular.",
};

describe("parseTaskBody", () => {
  test("accepts a choice task, trimmed", () => {
    expect(parseTaskBody({ ...choice, prompt: `  ${choice.prompt} ` })).toEqual({ body: choice });
  });

  test("keeps each option in the Unicode form sent, comparing them in NFC", () => {
    // Stored as sent, so a task resent the same is the same task (ADR 0024).
    const decomposed = { ...choice, options: ["cafe\u0301", "té"] };
    expect(parseTaskBody(decomposed)).toEqual({ body: decomposed });
  });

  test("collapses whitespace in the prompt and options, as a page shows them", () => {
    const code = {
      ...choice,
      prompt: "Which\nis valid?",
      options: ["if x:\n    pass", "if x: pass"],
    };
    expect(parseTaskBody(code)).toEqual({
      problem: "repeats option 0 as option 1; every option must differ",
    });

    const spaced = {
      ...choice,
      prompt: "Which\r\n\tis   valid?",
      options: ["a\u00a0!", "b\r\n\t is\fvalid "],
    };
    expect(parseTaskBody(spaced)).toEqual({
      body: { ...choice, prompt: "Which is valid?", options: ["a\u00a0!", "b is\fvalid"] },
    });
  });

  test("keeps keepOrder only when true", () => {
    expect(parseTaskBody({ ...choice, keepOrder: true })).toEqual({
      body: { ...choice, keepOrder: true },
    });
    expect(parseTaskBody({ ...choice, keepOrder: false })).toEqual({ body: choice });
    expect(parseTaskBody({ ...choice, keepOrder: "yes" })).toHaveProperty("problem");
  });

  test("accepts texts of 2000 characters, counted as stored: trimmed", () => {
    const long = "x".repeat(2000);
    const body = {
      ...choice,
      prompt: long,
      options: [long, `${long.slice(1)}y`],
      explanation: long,
    };
    expect(parseTaskBody(body)).toEqual({ body });

    const padded = {
      ...body,
      prompt: ` ${long}\n`,
      options: body.options.map((option) => `\t${option} `),
      explanation: `${long}\n\n`,
    };
    expect(parseTaskBody(padded)).toEqual({ body });
  });

  test("accepts one without an explanation", () => {
    const { explanation: _, ...bare } = choice;
    expect(parseTaskBody(bare)).toEqual({ body: bare });
  });

  // Each refusal says what is wrong and what would fix it: its reader is often
  // a model drafting tasks, which can correct only a mistake it is told about.
  test.each([
    ["not an object", "choice", "is not a task"],
    [
      "an unknown kind",
      { ...choice, kind: "essay" },
      'has an unknown kind; the kinds are "choice" and "typed"',
    ],
    ["a blank prompt", { ...choice, prompt: " " }, "has a prompt that is blank"],
    ["no prompt", { ...choice, prompt: undefined }, "has a prompt that is missing"],
    [
      "a prompt over 2000 characters",
      { ...choice, prompt: "x".repeat(2001) },
      "has a prompt that is over 2000 characters",
    ],
    [
      "a prompt carrying a NUL",
      { ...choice, prompt: "¿\u0000?" },
      "has a prompt that is not storable: it carries a NUL or an unpaired surrogate",
    ],
    ["one option", { ...choice, options: ["hablé"] }, "needs 2 to 26 options"],
    ["a blank option", { ...choice, options: ["hablé", ""] }, "has option 1 that is blank"],
    [
      "an option over 2000 characters",
      { ...choice, options: ["hablé", "x".repeat(2001)] },
      "has option 1 that is over 2000 characters",
    ],
    [
      "a malformed option",
      { ...choice, options: ["hablé", "\ud800"] },
      "has option 1 that is not storable: it carries a NUL or an unpaired surrogate",
    ],
    [
      "options that are not text, naming the first",
      { ...choice, options: ["hablé", 1, ""] },
      "has option 1 that is not text",
    ],
    [
      "duplicate options",
      { ...choice, options: ["hablé", "hablo", " hablé"] },
      "repeats option 0 as option 2; every option must differ",
    ],
    [
      "options equal but for their Unicode form",
      { ...choice, options: ["żółć", "żółć".normalize("NFD")] },
      "repeats option 0 as option 1; every option must differ",
    ],
    [
      "an answer out of range",
      { ...choice, answer: 2 },
      "needs its answer to be the index of the correct option, a whole number from 0 to 1",
    ],
    [
      "a fractional answer",
      { ...choice, answer: 0.5 },
      "needs its answer to be the index of the correct option, a whole number from 0 to 1",
    ],
    [
      "a blank explanation",
      { ...choice, explanation: "" },
      "has an explanation that is blank; leave a blank one out",
    ],
    [
      "an explanation over 2000 characters",
      { ...choice, explanation: "x".repeat(2001) },
      "has an explanation that is over 2000 characters",
    ],
  ])("refuses %s, saying why", (_, body, problem) => {
    expect(parseTaskBody(body)).toEqual({ problem });
  });

  test("never repeats what was sent, however long", () => {
    const long = "x".repeat(400_000);

    for (const body of [
      { ...choice, options: [long, long] },
      { ...choice, kind: long },
      { ...choice, answer: long },
    ]) {
      const read = parseTaskBody(body);
      expect("problem" in read && read.problem.length).toBeLessThan(120);
    }
  });
});

describe("presentTask", () => {
  const many: TaskBody = { ...choice, options: ["a", "b", "c", "d", "e", "f"], answer: 0 };

  test("presents only what a learner may see", () => {
    expect(presentTask({ ...choice, keepOrder: true }, "seed")).toEqual({
      kind: "choice",
      prompt: choice.prompt,
      options: expect.any(Array),
    });
  });

  test("shows every option once, each with its own choice wherever it lands", () => {
    const options = optionsOf(presentTask(many, "seed"));

    expect(options.toSorted((a, b) => a.choice - b.choice)).toEqual(
      many.options.map((text, choice) => ({ choice, text })),
    );
  });

  test("orders by the seed alone, and the seed decides the order", () => {
    const order = (seed: string) => optionsOf(presentTask(many, seed)).map(({ choice }) => choice);

    expect(order("same")).toEqual(order("same"));
    // Not every seed changes a given order, but among several some must.
    const orders = new Set(["a", "b", "c", "d", "e"].map((seed) => order(seed).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  test("keeps the author's order when asked to", () => {
    const kept = optionsOf(presentTask({ ...many, keepOrder: true }, "seed"));

    expect(kept.map(({ choice }) => choice)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("parseTaskResponse", () => {
  test("accepts an option's choice, and nothing else from the body", () => {
    expect(parseTaskResponse(choice, { choice: 1, outcome: "success" })).toEqual({ choice: 1 });
  });

  test("reads -0 as 0, as storing it will", () => {
    const read = parseTaskResponse(choice, { choice: -0 });
    expect(read && "choice" in read && Object.is(read.choice, 0)).toBe(true);
  });

  test.each([[{ choice: 2 }], [{ choice: -1 }], [{ choice: "0" }], [{}], [null]])(
    "refuses %j",
    (value) => {
      expect(parseTaskResponse(choice, value)).toBeUndefined();
    },
  );
});

describe("gradeResponse", () => {
  test("succeeds on the answer, with the feedback", () => {
    expect(gradeResponse(choice, { choice: 0 })).toEqual({
      kind: "choice",
      outcome: "success",
      correctChoice: 0,
      explanation: choice.explanation,
    });
  });

  test("fails on anything else, naming the answer", () => {
    expect(gradeResponse(choice, { choice: 1 })).toMatchObject({
      outcome: "failure",
      correctChoice: 0,
    });
  });
});

describe("a typed task", () => {
  const typed: TaskBody = {
    kind: "typed",
    prompt: "I am tired: Ich ___ müde.",
    accepted: ["bin"],
    explanation: "Sein, first person singular.",
  };
  const grade = (body: TaskBody, text: string) => gradeResponse(body, { text }).outcome;

  test("is stored with its answers' spacing collapsed and its language canonical", () => {
    expect(
      parseTaskBody({
        kind: "typed",
        prompt: " Bile, in Polish ",
        accepted: [" żółć ", "zolc"],
        answerLanguage: "pl-pl",
      }),
    ).toEqual({
      body: {
        kind: "typed",
        prompt: "Bile, in Polish",
        accepted: ["żółć", "zolc"],
        answerLanguage: "pl-PL",
      },
    });
  });

  test.each([
    ["no accepted answer", { accepted: [] }, "needs 1 to 20 accepted answers"],
    [
      "21 accepted answers",
      { accepted: Array.from({ length: 21 }, (_, i) => `a${i}`) },
      "needs 1 to 20 accepted answers",
    ],
    ["a blank answer", { accepted: ["bin", " "] }, "has accepted answer 1 that is blank"],
    [
      "an answer of 201 characters",
      { accepted: ["x".repeat(201)] },
      "has accepted answer 0 that is over 200 characters",
    ],
    [
      "two answers equal as compared",
      { accepted: ["Bin", " bin "] },
      "repeats accepted answer 0 as accepted answer 1, as answers are compared (case, spacing, and curly or straight quotes aside); list each once",
    ],
    [
      "a language that is not one",
      { answerLanguage: "German" },
      'has an answerLanguage that is not a language tag, such as "en" or "pt-BR"',
    ],
  ])("refuses %s, saying why", (_case, change, problem) => {
    expect(parseTaskBody({ ...typed, ...change })).toEqual({ problem });
  });

  test("accepts an answer of 200 characters, and several words", () => {
    expect(parseTaskBody({ ...typed, accepted: ["x".repeat(200), "ich bin"] })).toHaveProperty(
      "body",
    );
  });

  test("is presented without its answers or explanation", () => {
    expect(presentTask(typed, "seed")).toEqual({ kind: "typed", prompt: typed.prompt });
  });

  test("succeeds on an accepted answer, case, spacing, and curly or straight quotes aside", () => {
    expect(grade(typed, " Bin ")).toBe("success");
    expect(grade({ ...typed, accepted: ["ich bin"] }, "Ich   bin")).toBe("success");
    expect(grade({ ...typed, accepted: ["it's"] }, "it\u2019s")).toBe("success");
  });

  test("fails on anything else: punctuation, a slip, accents, nothing at all", () => {
    expect(grade(typed, "bin.")).toBe("failure");
    expect(grade({ ...typed, accepted: ["it's"] }, "its")).toBe("failure");
    expect(grade(typed, "ben")).toBe("failure");
    expect(grade(typed, "")).toBe("failure");
    expect(grade({ ...typed, accepted: ["żółć"] }, "zolc")).toBe("failure");
    // Unless the author lists the variant.
    expect(grade({ ...typed, accepted: ["żółć", "zolc"] }, "zolc")).toBe("success");
  });

  test("compares in NFC, whatever form the answer was typed in", () => {
    expect(normalizeAnswer("z\u0307o\u0301\u0142c\u0301")).toBe(normalizeAnswer("żółć"));
  });

  test("names the first accepted answer, whichever matched", () => {
    expect(gradeResponse({ ...typed, accepted: ["colour", "color"] }, { text: "color" })).toEqual({
      kind: "typed",
      outcome: "success",
      correctAnswer: "colour",
      explanation: typed.explanation,
    });
    expect(gradeResponse(typed, { text: "ben" })).toEqual({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
      explanation: typed.explanation,
    });
  });

  test("reads text exactly as sent, an empty one too, up to 500 characters", () => {
    expect(parseTaskResponse(typed, { text: " Bin " })).toEqual({ text: " Bin " });
    expect(parseTaskResponse(typed, { text: "" })).toEqual({ text: "" });
    expect(parseTaskResponse(typed, { text: "x".repeat(500) })).toEqual({ text: "x".repeat(500) });
    expect(parseTaskResponse(typed, { text: "x".repeat(501) })).toBeUndefined();
  });

  test.each([[{ choice: 0 }], [{ text: 5 }], [{ text: "a\u0000" }], [{}]])(
    "refuses %j",
    (value) => {
      expect(parseTaskResponse(typed, value)).toBeUndefined();
    },
  );
});

describe("Show answer", () => {
  const typed: TaskBody = { kind: "typed", prompt: "Ich ___ müde.", accepted: ["bin"] };

  test("is a response to either kind, graded a failure that shows the answer", () => {
    expect(parseTaskResponse(choice, { reveal: true })).toEqual({ reveal: true });
    expect(gradeResponse(choice, { reveal: true })).toMatchObject({
      outcome: "failure",
      correctChoice: 0,
    });
    expect(parseTaskResponse(typed, { reveal: true })).toEqual({ reveal: true });
    expect(gradeResponse(typed, { reveal: true })).toEqual({
      kind: "typed",
      outcome: "failure",
      correctAnswer: "bin",
    });
  });

  test.each([
    [{ reveal: 1 }],
    [{ reveal: false }],
    [{ reveal: true, choice: 0 }],
    [{ reveal: true, text: "bin" }],
    [{ choice: 0, text: "bin" }],
  ])("refuses %j: exactly one of choice, text, and reveal", (value) => {
    expect(parseTaskResponse(choice, value)).toBeUndefined();
    expect(parseTaskResponse(typed, value)).toBeUndefined();
  });

  test("refuses text to a choice task", () => {
    expect(parseTaskResponse(choice, { text: "hablé" })).toBeUndefined();
  });
});
