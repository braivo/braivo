// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { missedCharacters } from "./missed-characters.ts";

/** `answer` with what `typed` got wrong in brackets, or `undefined` unmarked. */
function marked(answer: string, typed: string) {
  return missedCharacters(answer, typed)
    ?.map(({ text, missed }) => (missed ? `[${text}]` : text))
    .join("");
}

test.each([
  ["a letter wrong", "bin", "ben", "b[i]n"],
  ["letters swapped", "receive", "recieve", "rec[e]ive"],
  ["a letter missing", "please", "pleese", "ple[a]se"],
  ["accents left out", "żółć", "zolc", "[ż][ó][ł][ć]"],
  ["one accent left out", "hablé", "hable", "habl[é]"],
  ["the case alone", "Bin", "bin", "Bin"],
  // Nothing grading ignores is marked, beside an error that counts.
  ["a typographic apostrophe", "don’t go", "don't gx", "don’t g[o]"],
  ["a run of spaces", "a  cat", "a cot", "a  c[a]t"],
  // An extra letter marks nothing, not the right one beside it.
  ["an extra letter", "café", "cafeé", "café"],
  ["an extra letter at the end", "see you later", "see you laterr", "see you later"],
  // A final sigma as any sigma, as lowercasing the whole word gives it.
  ["Greek capitals", "ΟΔΟΣ", "οδος", "ΟΔΟΣ"],
])("marks %s", (_, answer, typed, expected) => {
  expect(marked(answer, typed)).toBe(expected);
});

test("marks nothing of a different word: under half of it aligned", () => {
  expect(missedCharacters("please", "plz")).toBeUndefined();
  expect(missedCharacters("later", "soon")).toBeUndefined();
});

test("stays quick at the longest answer a typed task takes", () => {
  const started = performance.now();
  missedCharacters("é".repeat(500), "e".repeat(500));
  // Quadratic takes milliseconds: generous for a loaded machine, tight enough to catch worse.
  expect(performance.now() - started).toBeLessThan(500);
});
