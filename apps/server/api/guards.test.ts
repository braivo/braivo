// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { unstorableAt } from "./guards.ts";

describe("unstorableAt", () => {
  test.each([
    ["storable text, a surrogate pair included", { title: "Café 😀", ids: ["a", "b"] }, undefined],
    ["not text at all", [1, true, null, { n: 2 }], undefined],
    ["a NUL in the body itself", "a\u0000", ""],
    [
      "a NUL in a nested string",
      { tasks: [{ prompt: "ok" }, { prompt: "\u0000" }] },
      "tasks[1].prompt",
    ],
    ["a high surrogate alone", { id: "a\ud800" }, "id"],
    ["a low surrogate alone", { id: "\udfffa" }, "id"],
    ["a NUL in a key", { response: { "\u0000": 1 } }, 'response["\\u0000"]'],
    ["an unpaired surrogate in a key", { "\ud800": 1 }, '["\\ud800"]'],
    ["a key that is not a plain name", { "a.b": ["\u0000"] }, '["a.b"][0]'],
    ["the first of two, in order", { a: ["\u0000"], b: "\u0000" }, "a[0]"],
    ["a value before a later key", { a: "\u0000", "b\u0000": "ok" }, "a"],
    ["a key before its own value", { "a\u0000": "\u0000" }, '["a\\u0000"]'],
  ])("finds %s", (_label, value, at) => {
    expect(unstorableAt(value)).toBe(at);
  });

  test("reads a body nested deeper than a call stack", () => {
    const deep = JSON.parse(`${"[".repeat(100_000)}"\\u0000"${"]".repeat(100_000)}`);

    expect(unstorableAt(deep)).toBe("[0]".repeat(100_000));
  });
});
