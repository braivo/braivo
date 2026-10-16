// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { codePoints } from "./locator.ts";
import { joinPages } from "./pages.ts";
import { MAX_SLICE_CODE_POINTS, type SourceRange, type SourceSlice, sliceSource } from "./slice.ts";
import { joinCues } from "./transcript.ts";

type Source = Parameters<typeof sliceSource>[0];

function slice(source: Source, range: SourceRange): SourceSlice {
  const sliced = sliceSource(source, range);
  if ("problem" in sliced) throw new Error(sliced.problem);
  return sliced;
}

function problem(source: Source, range: SourceRange): string | undefined {
  const sliced = sliceSource(source, range);
  return "problem" in sliced ? sliced.problem : undefined;
}

/** Every slice from `range` on, following `next` to the end. */
function readAll(source: Source, range: SourceRange): SourceSlice[] {
  const slices = [slice(source, range)];
  while (slices.at(-1)!.next) slices.push(slice(source, slices.at(-1)!.next!));
  return slices;
}

/** A book of `count` pages, each about a thousand characters on lines of their own, labelled from 1. */
function book(count: number): Source {
  const joined = joinPages(
    Array.from({ length: count }, (_, index) => ({
      page: String(index + 1),
      text: `Página ${index + 1}.\n${"Hola, ¿qué tal?\n".repeat(60)}`,
    })),
  );
  if ("problem" in joined) throw new Error(joined.problem);
  return joined;
}

describe("reading part of a source", () => {
  test("reads a long text in bounded slices, cut at line breaks, until the cursor reaches its end", () => {
    const text = Array.from({ length: 3000 }, (_, index) => `Línea ${index} 🙂 del texto.`).join(
      "\n",
    );

    const slices = readAll({ text }, { characters: "0-" });

    expect(slices.length).toBeGreaterThan(2);
    for (const each of slices) {
      expect(each.end - each.start).toBeLessThanOrEqual(MAX_SLICE_CODE_POINTS);
      expect(each.length).toBe(codePoints(text));
    }
    // Each but the last ends just past a line break, and the next starts there.
    for (const [index, each] of slices.slice(0, -1).entries()) {
      expect(each.text.endsWith("\n")).toBe(true);
      expect(slices[index + 1]!.start).toBe(each.end);
    }
    expect(slices.map((each) => each.text).join("")).toBe(text);
    expect(slices.at(-1)).toMatchObject({ end: codePoints(text) });
    expect(slices.at(-1)!.next).toBeUndefined();
  });

  test("reads the pages asked for, by position, with their labels", () => {
    const source = book(100);

    const read = slice(source, { pages: "12-16" });

    expect(read.start).toBe(source.pagination![11]!.start);
    expect(read.end).toBe(source.pagination![16]!.start);
    expect(read.text.startsWith("Página 12.\n")).toBe(true);
    expect(read.pagination!.map(({ page }) => page)).toEqual(["12", "13", "14", "15", "16"]);
    expect(read.next).toBeUndefined();
    // The last page reads to the end of the text, and a range past it stops there.
    expect(slice(source, { pages: "100-200" })).toMatchObject({
      end: read.length,
      pagination: [{ page: "100" }],
    });
  });

  test("cuts a long run of pages at a page's start, and goes on from there", () => {
    const source = book(100);

    const slices = readAll(source, { pages: "1-" });

    expect(slices.length).toBeGreaterThan(4);
    const starts = new Set(source.pagination!.map(({ start }) => start));
    for (const each of slices.slice(0, -1)) {
      expect(each.end - each.start).toBeLessThanOrEqual(MAX_SLICE_CODE_POINTS);
      expect(starts.has(each.end)).toBe(true);
      expect(each.next).toEqual({ characters: `${each.end}-${each.length}` });
    }
    expect(slices.map((each) => each.text).join("")).toBe(source.text);
  });

  test("keeps a range's end while following it: what was asked, no more", () => {
    const source = book(100);

    const slices = readAll(source, { pages: "1-40" });

    expect(slices.at(-1)!.end).toBe(source.pagination![40]!.start);
    expect(slices.at(-1)!.pagination!.at(-1)!.page).toBe("40");
  });

  test("cuts a page with no line break in it at the cap itself", () => {
    const joined = joinPages([{ page: "1", text: "a".repeat(MAX_SLICE_CODE_POINTS * 2 + 5) }]);
    if ("problem" in joined) throw new Error(joined.problem);

    const read = slice(joined, { pages: "1-1" });

    expect(read).toMatchObject({
      start: 0,
      end: MAX_SLICE_CODE_POINTS,
      next: { characters: `${MAX_SLICE_CODE_POINTS}-${MAX_SLICE_CODE_POINTS * 2 + 5}` },
    });
    expect(readAll(joined, { pages: "1-1" }).at(-1)!.end).toBe(MAX_SLICE_CODE_POINTS * 2 + 5);
  });

  test("reads a recording's seconds from the cue being said at the first", () => {
    const transcript = joinCues([
      { at: 0, text: "Hola." },
      { at: 10, text: "El perro dice guau." },
      { at: 20, text: "El gato dice miau." },
      { at: 30, text: "Adiós." },
    ]);
    if ("problem" in transcript) throw new Error(transcript.problem);

    const read = slice(transcript, { seconds: "15-25.5" });

    expect(read.text).toBe("El perro dice guau.\nEl gato dice miau.\n");
    expect(read.timing).toEqual([
      { start: 6, at: 10 },
      { start: 26, at: 20 },
    ]);
    // A range between two cues still holds the one being said.
    expect(slice(transcript, { seconds: "12-13" }).text).toBe("El perro dice guau.\n");
    expect(slice(transcript, { seconds: "25-" }).text).toBe("El gato dice miau.\nAdiós.");
  });

  test("keeps a dense transcript's answer near its text's cap, cues and all", () => {
    // Ten thousand short cues, as rolling captions of a quick exchange make.
    const transcript = joinCues(
      Array.from({ length: 10_000 }, (_, index) => ({ at: index * 0.7, text: "Sí." })),
    );
    if ("problem" in transcript) throw new Error(transcript.problem);

    const slices = readAll(transcript, { seconds: "0-" });

    for (const each of slices) {
      expect(JSON.stringify(each).length).toBeLessThanOrEqual(MAX_SLICE_CODE_POINTS * 2);
    }
    expect(slices.map(({ text }) => text).join("")).toBe(transcript.text);
  });

  test("counts characters in code points, as citations do", () => {
    const read = slice({ text: "🙂 hola 🙂 adiós" }, { characters: "2-8" });

    expect(read).toEqual({ text: "hola 🙂", start: 2, end: 8, length: 14 });
  });

  test("refuses a range the source cannot answer, saying which it can", () => {
    const paged = book(30);
    const transcript = joinCues([
      { at: 0, text: "Hola." },
      { at: 62.5, text: "Adiós." },
    ]);
    if ("problem" in transcript) throw new Error(transcript.problem);
    const plain = { text: "Hola." };

    expect(problem(paged, { pages: "40-45" })).toBe(
      "This source has 30 pages: ask for pages 1 to 30.",
    );
    expect(problem(paged, { pages: "0-3" })).toBe(
      "This source has 30 pages: ask for pages 1 to 30.",
    );
    expect(problem(transcript, { seconds: "90-" })).toBe(
      "This recording's last cue starts at second 62.5: ask for seconds before it.",
    );
    expect(problem(plain, { characters: "5-" })).toBe(
      "This source has 5 characters: start before 5.",
    );
    expect(problem(plain, { pages: "1-" })).toBe(
      "This source has no pages: read it by characters.",
    );
    expect(problem(paged, { seconds: "0-" })).toBe(
      "This source has no timing: read it by characters.",
    );
    expect(problem(paged, { pages: "5-3" })).toBe("The range 5-3 ends before it starts.");
    expect(problem(plain, { characters: "3-3" })).toBe("The range 3-3 ends before it starts.");
    expect(problem(plain, { characters: "1.5-" })).toMatch(/whole numbers/);
    expect(problem(plain, { characters: "12" })).toMatch(/such as 12-16/);
    expect(problem(paged, { pages: "1-", characters: "0-" })).toMatch(/one of/);
    expect(problem(paged, {})).toMatch(/one of/);
  });
});
