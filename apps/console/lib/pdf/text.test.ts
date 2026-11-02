// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { joinPages, locateQuote } from "@braivo/server/content";
import { describe, expect, test } from "vite-plus/test";

import { assemble, classify, coverage, type Item, normalize, textFeatures } from "./text.ts";

/** Lines as pdf.js streams them: one item each, 14 pt apart from the top, 12 pt tall. */
const lines = (...texts: string[]): Item[] =>
  texts.map((str, index) => ({ str, x: 72, y: 720 - index * 14, w: 100, h: 12, eol: true }));

describe("a page's text", () => {
  test("joins a paragraph's lines with a space, and paragraphs with a blank line", () => {
    const items = [
      ...lines("Hola means", "hello."),
      // A gap of two lines: a new paragraph.
      { str: "Adios means goodbye.", x: 72, y: 720 - 14 - 40, w: 100, h: 12, eol: true },
    ];
    expect(assemble(items)).toBe("Hola means hello.\n\nAdios means goodbye.");
  });

  test("keeps a printed hyphen at a line's end, without a space", () => {
    expect(assemble(lines("a well-", "known greeting"))).toBe("a well-known greeting");
  });

  test("starts a paragraph where the text jumps back up, as to a new column", () => {
    const items = [...lines("Column one."), { ...lines("Column two.")[0]!, x: 320, y: 740 }];
    expect(assemble(items)).toBe("Column one.\n\nColumn two.");
  });

  test("takes a moved baseline as a new line, even without pdf.js's end of line", () => {
    const items = lines("Uno", "dos").map((item) => ({ ...item, eol: false }));
    expect(assemble(items)).toBe("Uno dos");
  });

  test("spells out ligatures, drops invisible marks, and composes accents", () => {
    expect(normalize("ﬁnal ﬂoor of­​the﻿ café")).toBe("final floor ofthe café");
  });
});

describe("quotes from the saved pages", () => {
  // Two pages as read, then saved as a paged source (sources-8) and cited (sources-15).
  const first = assemble(lines("The ﬁnal well-", "known rule: 𝑥 squared.", "End of page one."));
  const second = assemble(lines("Start of page two."));
  const joined = joinPages([
    { page: "1", text: first },
    { page: "2", text: second },
  ]);
  const text = "text" in joined ? joined.text : "";

  test.each([
    "final well-known rule",
    "𝑥 squared",
    // Across the page boundary: any run of whitespace matches the blank line.
    "End of page one. Start of page two.",
  ])("locates %s", (quote) => {
    expect(locateQuote(text, quote)).toMatchObject({ kind: "located" });
  });

  test("does not locate a quote copied with the ligature the PDF drew", () => {
    expect(locateQuote(text, "ﬁnal")).not.toMatchObject({ kind: "located" });
  });
});

describe("how far a page's text is trusted", () => {
  const features = (text: string, rows: number) => ({
    ...textFeatures(text, [], 612, 792),
    textRows: rows,
  });

  test("calls a page without a visible character no-text, before looking at images", () => {
    expect(classify(features(" \n ", 0))).toBe("no-text");
  });

  test("doubts text with no letter or digit, or over 5% a font's codes", () => {
    expect(classify(features("— · —", 0.5))).toBe("doubtful");
    expect(classify(features("Hola a todos", 0.5))).toBe("doubtful");
    expect(classify(features(`${"a".repeat(95)}${"�".repeat(5)}`, 0.5))).toBe("text");
  });

  test("trusts text spread down the page without looking at its images", () => {
    expect(classify(features("Hola means hello.", 0.06))).toBe("text");
  });

  test("asks about images only for sparse text, doubting it over a scan or when unknown", () => {
    const sparse = features("Fernwood School", 0.024);
    expect(classify(sparse)).toBe("needs-images");
    expect(classify(sparse, 0.3)).toBe("doubtful");
    expect(classify(sparse, -1)).toBe("doubtful");
    expect(classify(sparse, 0.29)).toBe("text");
  });

  test("measures how far down the page text reaches, by rows", () => {
    // One 10 pt line on a 792 pt page: one or two of 85 rows.
    expect(coverage([[72, 700, 300, 712]], 612, 792, true)).toBeCloseTo(2 / 85);
    expect(coverage([[0, 0, 612, 792]], 612, 792)).toBe(1);
  });

  test("counts nothing for text drawn off the page, as cropped text is", () => {
    expect(coverage([[-100, 0, -20, 10]], 612, 792, true)).toBe(0);
    expect(coverage([[700, 0, 800, 10]], 612, 792)).toBe(0);
  });
});
