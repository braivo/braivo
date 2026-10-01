// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { locateQuote } from "./citation.ts";

const lesson = "# Saludos\n\nHola significa hello.\nAdiós significa\ngoodbye.\n";

describe("locating a quote", () => {
  test("answers where it starts and ends", () => {
    expect(locateQuote(lesson, "Hola significa hello.")).toEqual({
      kind: "located",
      start: 11,
      end: 32,
    });
  });

  test("matches across reflowed whitespace, and covers the text's own", () => {
    // The text breaks the line where the quote has one space.
    const located = locateQuote(lesson, "  Adiós significa   goodbye. ");

    expect(located).toEqual({ kind: "located", start: 33, end: 57 });
    expect(lesson.slice(33, 57)).toBe("Adiós significa\ngoodbye.");
  });

  test("matches a quote typed with decomposed accents", () => {
    expect(locateQuote(lesson, "Adiós")).toMatchObject({ kind: "located", start: 33 });
  });

  test("counts code points, so a character outside the BMP is one position", () => {
    const text = "🙂 Hola 🙂 adiós";

    expect(locateQuote(text, "adiós")).toEqual({ kind: "located", start: 9, end: 14 });
    // `Array.from` splits by code point, which is the unit being tested here.
    expect(Array.from(text).slice(9, 14).join("")).toBe("adiós");
  });

  test("tells a unique quote from a repeated one when it starts outside the BMP", () => {
    expect(locateQuote("🙂 Hola", "🙂")).toEqual({ kind: "located", start: 0, end: 1 });
    expect(locateQuote("🙂🙂🙂", "🙂🙂")).toEqual({ kind: "ambiguous" });
  });

  test("takes regular-expression syntax literally", () => {
    expect(locateQuote("¿Qué (tal)? 2+2=4 [a-z]*", "(tal)? 2+2=4 [a-z]*")).toMatchObject({
      kind: "located",
    });
    expect(locateQuote("Hola", "H.la")).toEqual({ kind: "missing" });
  });

  test("is exact about letters and case", () => {
    expect(locateQuote(lesson, "hola significa hello.")).toEqual({ kind: "missing" });
  });

  test("refuses a quote occurring twice, overlapping included", () => {
    expect(locateQuote(lesson, "significa")).toEqual({ kind: "ambiguous" });
    expect(locateQuote("la la la", "la la")).toEqual({ kind: "ambiguous" });
  });

  test.each([
    ["blank", " \n ", "blank"],
    ["longer than a passage", "a".repeat(2001), "too-long"],
    ["carrying an unpaired surrogate", "Hola \ud800", "missing"],
  ])("refuses a quote that is %s", (_label, quote, kind) => {
    expect(locateQuote(lesson, quote)).toEqual({ kind });
  });
});
