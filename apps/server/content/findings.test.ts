// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { type Finding, taskFindings } from "./findings.ts";
import type { TaskBody } from "./task.ts";

const typed = (...accepted: string[]): TaskBody => ({ kind: "typed", prompt: "Say it.", accepted });

const choice = (options: string[], answer = 0): TaskBody => ({
  kind: "choice",
  prompt: "Which one?",
  options,
  answer,
});

/** The trailing-punctuation finding for a task accepting only `answer`, if any. */
const trailing = (answer: string) =>
  taskFindings(typed(answer)).find(({ code }) => code === "typed-trailing-punctuation");

describe("typed-trailing-punctuation", () => {
  test.each([
    ["Hello.", "Hello"],
    ["“Hello.”", "“Hello”"],
    ["„Dzień dobry.”", "„Dzień dobry”"],
    ['"Hello!"', '"Hello"'],
    ["Wait...", "Wait"],
    ["Wait…", "Wait"],
    ["Dzień dobry.", "Dzień dobry"],
    ["Ça va ?", "Ça va"],
    ["42.", "42"],
    ["-3,5.", "-3,5"],
    ["3,5.", "3,5"],
    ["“42.”", "“42”"],
    ["Mr.", "Mr"],
    ["« Bonjour. »", "« Bonjour »"],
    ["np.", "np"],
    // Quotes as each language pairs them.
    ["„Hallo.“", "„Hallo“"],
    ["‚Na.‘", "‚Na‘"],
    ["”Hej.”", "”Hej”"],
    ["»Hej.»", "»Hej»"],
    ["»Hallo.«", "»Hallo«"],
    ["‹Salut.›", "‹Salut›"],
    ["「こんにちは。」", "「こんにちは」"],
    ["『はい。』", "『はい』"],
    // Sentence marks beyond Latin script.
    ["你好。", "你好"],
    ["你好！", "你好"],
    ["どう？", "どう"],
    ["مرحبا؟", "مرحبا"],
    ["خدا حافظ۔", "خدا حافظ"],
    ["नमस्ते।", "नमस्ते"],
    ["Բարեւ։", "Բարեւ"],
    ["ሰላም።", "ሰላም"],
  ])("%s is flagged, suggesting %s", (answer, suggestion) => {
    expect(trailing(answer)).toEqual({ code: "typed-trailing-punctuation", answer, suggestion });
  });

  test.each(["¿Qué?", "“¿Qué?”", "“¡Hola!”", "¡Hola!", "“ ¿Qué?”", "« ¡Hola ! »"])(
    "%s is flagged without a suggestion, its opening mark left dangling",
    (answer) => {
      expect(trailing(answer)).toEqual({ code: "typed-trailing-punctuation", answer });
    },
  );

  // A Greek question mark is a semicolon once NFC, which ends no sentence.
  test.each(["?", "...", "“?”", "3.5", "Dr. Who", "Hello", "km/h", "。", "「。」", "Γεια;"])(
    "%s is not flagged",
    (answer) => {
      expect(trailing(answer)).toBeUndefined();
    },
  );

  test("an answer already accompanied by its variant is not flagged, as answers are compared", () => {
    expect(taskFindings(typed("Hello.", "hello"))).toEqual([]);
    expect(taskFindings(typed("“Hello.”", '"hello"'))).toEqual([]);
  });

  test("with 20 answers, a 21st cannot be added: flagged without a suggestion", () => {
    const answers = ["Hello.", ...Array.from({ length: 19 }, (_, index) => `word${index}`)];
    expect(taskFindings(typed(...answers))).toEqual([
      { code: "typed-trailing-punctuation", answer: "Hello." },
    ]);
  });

  test("each answer is checked", () => {
    expect(taskFindings(typed("Hi.", "Hello!"))).toEqual([
      { code: "typed-trailing-punctuation", answer: "Hi.", suggestion: "Hi" },
      { code: "typed-trailing-punctuation", answer: "Hello!", suggestion: "Hello" },
    ]);
  });
});

describe("typed-literal-delimiters", () => {
  test.each([
    "colour / color",
    "(to) go",
    "f(x)",
    "to go (informal) / to leave",
    "( to ) go",
    // Fullwidth, as CJK text writes them, unspaced.
    "（to） go",
    "色／颜色",
  ])("%s is flagged once", (answer) => {
    expect(taskFindings(typed(answer))).toEqual([{ code: "typed-literal-delimiters", answer }]);
  });

  test.each(["km/h", "and/or", "()", "( )", "(\u3000)", "a/ b", "（）", "（ ）"])(
    "%s is not flagged",
    (answer) => {
      expect(taskFindings(typed(answer))).toEqual([]);
    },
  );

  test("with a trailing mark too, both are said", () => {
    expect(taskFindings(typed("(to) go."))).toEqual([
      { code: "typed-trailing-punctuation", answer: "(to) go.", suggestion: "(to) go" },
      { code: "typed-literal-delimiters", answer: "(to) go." },
    ]);
  });
});

describe("choice-correct-alike", () => {
  test("names each fold the correct option and a distractor still differ by", () => {
    expect(taskFindings(choice(["Paris", "paris.", "London"]))).toEqual([
      {
        code: "choice-correct-alike",
        correct: "Paris",
        other: "paris.",
        differences: ["case", "punctuation"],
      },
    ] satisfies Finding[]);
  });

  test("quotes alone", () => {
    expect(taskFindings(choice(["“Paris”", '"Paris"']))).toEqual([
      {
        code: "choice-correct-alike",
        correct: "“Paris”",
        other: '"Paris"',
        differences: ["quotes"],
      },
    ]);
  });

  test("an apostrophe counts as a quote mark: a contraction is alike its spelling without", () => {
    expect(taskFindings(choice(["can't", "cant"]))).toEqual([
      { code: "choice-correct-alike", correct: "can't", other: "cant", differences: ["quotes"] },
    ]);
  });

  test("beyond Latin script: CJK brackets are quotes, its full stop a final mark", () => {
    expect(taskFindings(choice(["東京", "「東京」", "東京。"]))).toEqual([
      { code: "choice-correct-alike", correct: "東京", other: "「東京」", differences: ["quotes"] },
      {
        code: "choice-correct-alike",
        correct: "東京",
        other: "東京。",
        differences: ["punctuation"],
      },
    ]);
  });

  test("a final mark inside quotes is punctuation, not quotes", () => {
    expect(taskFindings(choice(["“Paris.”", "“Paris”"], 1))).toEqual([
      {
        code: "choice-correct-alike",
        correct: "“Paris”",
        other: "“Paris.”",
        differences: ["punctuation"],
      },
    ]);
  });

  test("case alone, which may be the lesson itself, is still said", () => {
    expect(taskFindings(choice(["Polak", "polak"]))).toEqual([
      { code: "choice-correct-alike", correct: "Polak", other: "polak", differences: ["case"] },
    ]);
  });

  test("each distractor alike is said, distractors alike among themselves are not", () => {
    expect(taskFindings(choice(["Rome", "paris", "Paris."], 0))).toEqual([]);
    expect(taskFindings(choice(["Paris", "paris", "PARIS!"]))).toEqual([
      { code: "choice-correct-alike", correct: "Paris", other: "paris", differences: ["case"] },
      {
        code: "choice-correct-alike",
        correct: "Paris",
        other: "PARIS!",
        differences: ["case", "punctuation"],
      },
    ]);
  });

  test("when two folds each hide the difference, both are named", () => {
    expect(taskFindings(choice(['"Paris."', '"Paris".']))).toEqual([
      {
        code: "choice-correct-alike",
        correct: '"Paris."',
        other: '"Paris".',
        differences: ["punctuation", "quotes"],
      },
    ]);
  });

  test("options told apart by a no-break space alone are not alike, as none of the three", () => {
    expect(taskFindings(choice(["New York", "New\u00a0York"]))).toEqual([]);
    expect(taskFindings(choice(["New York", "new\u00a0york."]))).toEqual([]);
  });

  test("options that are only marks are not alike", () => {
    expect(taskFindings(choice(["?", "!"]))).toEqual([]);
  });

  test("accents count", () => {
    expect(taskFindings(choice(["été", "ete"]))).toEqual([]);
  });
});
