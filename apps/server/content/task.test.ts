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

test("presents a task without its answer or explanation", () => {
  expect(presentTask(choice)).toEqual({
    kind: "choice",
    prompt: choice.prompt,
    options: choice.options,
  });
});

describe("parseTaskResponse", () => {
  test("accepts an option's index, and nothing else from the body", () => {
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
