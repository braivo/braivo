// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { locateQuote } from "./citation.ts";
import { joinCues, momentOf } from "./transcript.ts";

describe("joining a recording's cues into a transcript", () => {
  test("puts each cue on a line of its own, and keeps where and when each begins", () => {
    const joined = joinCues([
      { at: 0.5, text: " ¡Hola! 🙂 " },
      { at: 3, text: "¿Qué tal?\r\n¿Bien?" },
      { at: 7.25, text: "Adiós." },
    ]);

    expect(joined).toEqual({
      text: "¡Hola! 🙂\n¿Qué tal?\n¿Bien?\nAdiós.",
      // In code points, as citations count them: the emoji is one.
      timing: [
        { start: 0, at: 0.5 },
        { start: 9, at: 3 },
        { start: 26, at: 7.25 },
      ],
    });
  });

  test("agrees with where a citation finds the words, so a quote names its moment", () => {
    const joined = joinCues([
      { at: 0, text: "Hola significa hello." },
      { at: 12, text: "Adiós significa goodbye." },
    ]);
    if ("problem" in joined) throw new Error(joined.problem);

    const located = locateQuote(joined.text, "significa goodbye");
    if (located.kind !== "located") throw new Error(located.kind);

    expect(momentOf(joined.timing, located.start)).toBe(12);
  });

  test.each([
    ["no cues", [], "A transcript needs 1 to 100000 cues"],
    ["a negative time", [{ at: -1, text: "Hola" }], "Cue 0 needs `at`: seconds from 0 to 86400"],
    ["a time that is not a number", [{ at: Number.NaN, text: "Hola" }], "Cue 0 needs `at`"],
    [
      "cues out of order",
      [
        { at: 5, text: "Hola" },
        { at: 2, text: "Adiós" },
      ],
      "Cue 1 starts before the cue before it; send cues in order",
    ],
    ["a blank cue", [{ at: 0, text: "  " }], "Cue 0 has no text Braivo can store"],
    ["a NUL", [{ at: 0, text: "Hola\u0000" }], "Cue 0 has no text Braivo can store"],
  ])("refuses %s, saying which cue and why", (_label, cues, problem) => {
    const joined = joinCues(cues);
    expect("problem" in joined && joined.problem).toContain(problem);
  });
});

describe("the moment a position is said at", () => {
  const timing = [
    { start: 0, at: 1 },
    { start: 10, at: 4 },
  ];

  test("is the start of the cue it falls in", () => {
    expect(momentOf(timing, 0)).toBe(1);
    expect(momentOf(timing, 9)).toBe(1);
    expect(momentOf(timing, 10)).toBe(4);
    expect(momentOf(timing, 500)).toBe(4);
  });

  test("is unknown before the first cue", () => {
    expect(momentOf([{ start: 5, at: 1 }], 2)).toBeUndefined();
  });
});
