// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { locateQuote } from "./citation.ts";
import { joinPages, pageOf } from "./pages.ts";

describe("joining a document's pages", () => {
  test("separates pages by a blank line, and keeps where each begins and its label", () => {
    const joined = joinPages([
      { page: " iv ", text: "Prólogo 🙂\r\n" },
      { page: "1", text: "\nLección 1\n\nHola.\n" },
      { page: "1", text: "Otra vez." },
    ]);

    expect(joined).toEqual({
      text: "Prólogo 🙂\n\nLección 1\n\nHola.\n\nOtra vez.",
      // In code points, as citations count them: the emoji is one.
      pagination: [
        { start: 0, page: "iv" },
        { start: 11, page: "1" },
        { start: 29, page: "1" },
      ],
    });
  });

  test("counts a label's length in NFC, the form it is kept in", () => {
    // 16 letters, 32 code points as sent: a letter and its accent each.
    const label = "é".repeat(16);
    const joined = joinPages([{ page: label.normalize("NFD"), text: "Hola" }]);

    expect(joined).toEqual({ text: "Hola", pagination: [{ start: 0, page: label }] });
  });

  test("agrees with where a citation finds the words, so a quote names its page", () => {
    const joined = joinPages([
      { page: "11", text: "Hola significa hello." },
      { page: "12", text: "Adiós significa goodbye." },
    ]);
    if ("problem" in joined) throw new Error(joined.problem);

    const located = locateQuote(joined.text, "significa goodbye");
    if (located.kind !== "located") throw new Error(located.kind);

    expect(pageOf(joined.pagination, located.start)).toBe("12");
    // A quote spanning pages is on the one it starts on.
    const spanning = locateQuote(joined.text, "hello. Adiós");
    if (spanning.kind !== "located") throw new Error(spanning.kind);
    expect(pageOf(joined.pagination, spanning.start)).toBe("11");
  });

  test.each([
    ["no pages", [], "A document needs 1 to 10000 pages"],
    ["a blank label", [{ page: " ", text: "Hola" }], "Page 0 needs `page`"],
    ["a label too long to be one", [{ page: "1".repeat(17), text: "Hola" }], "Page 0 needs `page`"],
    ["a control character in a label", [{ page: "1\n2", text: "Hola" }], "Page 0 needs `page`"],
    ["a lone surrogate in a label", [{ page: "\uD800", text: "Hola" }], "Page 0 needs `page`"],
    [
      "a page without words",
      [
        { page: "1", text: "Hola" },
        { page: "2", text: " \n " },
      ],
      "Page 1 has no text Braivo can store",
    ],
  ])("refuses %s, saying which page and why", (_label, pages, problem) => {
    const joined = joinPages(pages);
    expect("problem" in joined && joined.problem).toContain(problem);
  });
});
