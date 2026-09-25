// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import {
  gradeResponse,
  parseTaskBody,
  parseTaskResponse,
  presentTask,
  type TaskBody,
} from "./task.ts";

const choice: TaskBody = {
  kind: "choice",
  prompt: "Past tense of 'hablar', first person?",
  options: ["hablé", "hablo"],
  answer: 0,
  explanation: "Preterite, first person singular.",
};

describe("parseTaskBody", () => {
  test("accepts a choice task, trimmed", () => {
    expect(parseTaskBody({ ...choice, prompt: `  ${choice.prompt} ` })).toEqual(choice);
  });

  test("keeps keepOrder only when true", () => {
    expect(parseTaskBody({ ...choice, keepOrder: true })).toEqual({ ...choice, keepOrder: true });
    expect(parseTaskBody({ ...choice, keepOrder: false })).toEqual(choice);
    expect(parseTaskBody({ ...choice, keepOrder: "yes" })).toBeUndefined();
  });

  test("accepts one without an explanation", () => {
    const { explanation: _, ...bare } = choice;
    expect(parseTaskBody(bare)).toEqual(bare);
  });

  test.each([
    ["not an object", "choice"],
    ["an unknown kind", { ...choice, kind: "essay" }],
    ["a blank prompt", { ...choice, prompt: " " }],
    ["one option", { ...choice, options: ["hablé"] }],
    ["a blank option", { ...choice, options: ["hablé", ""] }],
    ["duplicate options", { ...choice, options: ["hablé", " hablé"] }],
    ["an answer out of range", { ...choice, answer: 2 }],
    ["a fractional answer", { ...choice, answer: 0.5 }],
    ["a blank explanation", { ...choice, explanation: "" }],
  ])("refuses %s", (_, body) => {
    expect(parseTaskBody(body)).toBeUndefined();
  });
});

describe("presentTask", () => {
  const many: TaskBody = { ...choice, options: ["a", "b", "c", "d", "e", "f"], answer: 0 };

  test("presents a task without its answer or explanation", () => {
    expect(presentTask(choice, "seed")).toEqual({
      kind: "choice",
      prompt: choice.prompt,
      options: expect.any(Array),
    });
  });

  test("shows every option once, each with its own choice wherever it lands", () => {
    const { options } = presentTask(many, "seed");

    expect(options.toSorted((a, b) => a.choice - b.choice)).toEqual(
      many.options.map((text, choice) => ({ choice, text })),
    );
  });

  test("orders by the seed alone, and the seed decides the order", () => {
    const order = (seed: string) => presentTask(many, seed).options.map(({ choice }) => choice);

    expect(order("same")).toEqual(order("same"));
    // Not every seed changes a given order, but among several some must.
    const orders = new Set(["a", "b", "c", "d", "e"].map((seed) => order(seed).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  test("keeps the author's order when asked to", () => {
    const kept = presentTask({ ...many, keepOrder: true }, "seed").options;

    expect(kept.map(({ choice }) => choice)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("parseTaskResponse", () => {
  test("accepts an option's choice, and nothing else from the body", () => {
    expect(parseTaskResponse(choice, { choice: 1, outcome: "success" })).toEqual({ choice: 1 });
  });

  test("reads -0 as 0, as storing it will", () => {
    expect(Object.is(parseTaskResponse(choice, { choice: -0 })?.choice, 0)).toBe(true);
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
      outcome: "success",
      answer: 0,
      explanation: choice.explanation,
    });
  });

  test("fails on anything else, naming the answer", () => {
    expect(gradeResponse(choice, { choice: 1 })).toMatchObject({ outcome: "failure", answer: 0 });
  });
});
