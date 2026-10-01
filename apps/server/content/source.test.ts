// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { normalizeSourceText, parseLanguageTag, parseSourceUrl, sourceDigest } from "./source.ts";

describe("what makes two sources the same", () => {
  const lesson = { title: "Unidad 1", text: "Hola", url: "https://example.com/u1", language: "es" };

  test("is every field, each in its place", () => {
    expect(sourceDigest(lesson)).toBe(sourceDigest({ ...lesson }));
    expect(sourceDigest(lesson)).toMatch(/^[0-9a-f]{64}$/);
    // Text moved between fields is another source, though the bytes run the same.
    expect(sourceDigest({ ...lesson, title: "Unidad 1H", text: "ola" })).not.toBe(
      sourceDigest(lesson),
    );
    expect(sourceDigest({ title: "a", text: "b", language: "es" })).not.toBe(
      sourceDigest({ title: "a", text: "b", url: "es" }),
    );
  });

  test("counts the original file, whatever else the source has", () => {
    const original = "a".repeat(64);
    const kept = sourceDigest({ ...lesson, original });

    expect(kept).not.toBe(sourceDigest(lesson));
    expect(kept).not.toBe(sourceDigest({ ...lesson, original: "b".repeat(64) }));
    expect(sourceDigest({ ...lesson, pagination: [{ start: 0, page: "1" }], original })).not.toBe(
      kept,
    );
  });

  test("counts a document's pagination, which one page's label changes", () => {
    const paged = sourceDigest({ ...lesson, pagination: [{ start: 0, page: "1" }] });

    expect(paged).not.toBe(sourceDigest(lesson));
    expect(paged).not.toBe(sourceDigest({ ...lesson, pagination: [{ start: 0, page: "2" }] }));
  });

  test("counts a transcript's timing", () => {
    const timed = sourceDigest({ ...lesson, timing: [{ start: 0, at: 1 }] });

    expect(timed).not.toBe(sourceDigest(lesson));
    expect(timed).not.toBe(sourceDigest({ ...lesson, timing: [{ start: 0, at: 2 }] }));
  });
});

describe("normalizing source text", () => {
  test("gives every line ending one spelling", () => {
    expect(normalizeSourceText("uno\r\ndos\rtres\n")).toBe("uno\ndos\ntres\n");
  });

  test("composes characters, so a quote typed either way matches", () => {
    expect(normalizeSourceText("café")).toBe("café");
  });

  test("keeps everything else as given, surrounding whitespace included", () => {
    expect(normalizeSourceText("  # Unidad 1\n\n  Hola  ")).toBe("  # Unidad 1\n\n  Hola  ");
  });

  test.each([
    ["empty", ""],
    ["blank", " \n\t "],
    ["carrying a NUL", "Hola\u0000"],
    ["carrying an unpaired surrogate", "Hola \ud800"],
  ])("refuses text that is %s", (_label, text) => {
    expect(normalizeSourceText(text)).toBeUndefined();
  });
});

describe("reading a source's link", () => {
  test("keeps a YouTube or web link, in its canonical form", () => {
    expect(parseSourceUrl(" HTTPS://www.YouTube.com/watch?v=dQw4w9WgXcQ&t=42 ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    );
    expect(parseSourceUrl("http://example.com/unidad-1")).toBe("http://example.com/unidad-1");
  });

  test.each([
    ["not a URL", "youtube.com/watch?v=abc"],
    ["a script", "javascript:alert(1)"],
    ["a local file", "file:///etc/passwd"],
    ["carrying credentials", "https://teacher:secret@example.com/notes"],
    ["longer than any shared link", `https://example.com/${"a".repeat(2048)}`],
    // Short as typed, but percent-encoded to 2420 characters.
    ["too long once encoded", `https://example.com/${"é".repeat(400)}`],
  ])("refuses a link that is %s", (_label, value) => {
    expect(parseSourceUrl(value)).toBeUndefined();
  });
});

describe("reading a source's language", () => {
  test("gives each language one spelling", () => {
    expect(parseLanguageTag("es")).toBe("es");
    expect(parseLanguageTag(" es-mx ")).toBe("es-MX");
    expect(parseLanguageTag("zh-hant-tw")).toBe("zh-Hant-TW");
  });

  test.each([
    ["empty", ""],
    ["not a tag", "Spanish language"],
    ["a language's name", "Spanish"],
    ["private use only", "x-klingon"],
    ["too long to be a language", `es-${"a".repeat(40)}`],
  ])("refuses a tag that is %s", (_label, value) => {
    expect(parseLanguageTag(value)).toBeUndefined();
  });
});
