// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { courseRef, isUrlLabel, parseCourseRef, urlLabel } from "./course-ref.ts";

describe("urlLabel", () => {
  test("keeps the words, lowercased, any script's, hyphens between", () => {
    expect(urlLabel("Everyday English")).toBe("everyday-english");
    expect(urlLabel("Język polski: Część 2!")).toBe("język-polski-część-2");
    expect(urlLabel("Русский язык")).toBe("русский-язык");
    expect(urlLabel("日本語 入門")).toBe("日本語-入門");
  });

  test("composes accents, so one title gives one label however it was typed", () => {
    expect(urlLabel("Cafe\u0301")).toBe(urlLabel("Café"));
  });

  test("keeps nothing that could leave the segment", () => {
    expect(urlLabel("../a/b?c#d%2F e‮f")).toBe("a-b-c-d-2f-e-f");
  });

  test("is empty for text with no letters or digits, marks alone included", () => {
    expect(urlLabel("?!…")).toBe("");
    expect(urlLabel("\u0301 \u0301")).toBe("");
  });

  test("keeps marks on a letter or digit, and none on nothing", () => {
    expect(urlLabel("\u0301a b\u0302\u0301 \u0301c")).toBe("a-b\u0302\u0301-c");
  });

  test("cuts at 200 code units too, however many marks one character stacks", () => {
    const stacked = `á${"\u0301".repeat(149)}`;
    expect(urlLabel(stacked.repeat(3))).toBe(stacked);
  });

  test("cuts at 80 characters, never inside one or after a hyphen", () => {
    expect(urlLabel(`${"é".repeat(79)} ${"e\u0301".repeat(5)}`)).toBe("é".repeat(79));
  });
});

describe("isUrlLabel", () => {
  test("accepts what urlLabel writes, and nothing it would change", () => {
    expect(isUrlLabel("everyday-english")).toBe(true);
    expect(isUrlLabel("język-polski-2")).toBe(true);
    for (const text of [
      "",
      "\u0301",
      "\u0301a",
      "a-\u0301b",
      "Everyday",
      "a--b",
      "-a",
      "a-",
      "a b",
      "a/b",
      "e\u0301",
      "x".repeat(81),
    ]) {
      expect(isUrlLabel(text), text).toBe(false);
    }
  });
});

describe("courseRef", () => {
  test("follows the number with its label, or is the number alone without one", () => {
    expect(courseRef({ number: 4732, urlLabel: "everyday-english" })).toBe("4732-everyday-english");
    expect(courseRef({ number: 4732, urlLabel: "" })).toBe("4732");
  });
});

describe("parseCourseRef", () => {
  test("reads the number, and the label after it, whatever it says", () => {
    expect(parseCourseRef("4732")).toEqual({ number: 4732 });
    expect(parseCourseRef("4732-everyday-english")).toEqual({
      number: 4732,
      urlLabel: "everyday-english",
    });
    expect(parseCourseRef("12-2026-english-a1")).toEqual({
      number: 12,
      urlLabel: "2026-english-a1",
    });
    expect(parseCourseRef("2147483647-x")).toEqual({ number: 2_147_483_647, urlLabel: "x" });
  });

  test("reads an ID, though it may start like a number", () => {
    const id = "12345678-9abc-4def-8123-456789abcdef";
    expect(parseCourseRef(id)).toEqual({ id });
  });

  test("names nothing otherwise", () => {
    for (const ref of ["", "0", "04732", "+1", "-1", "1.5", "1e3", " 1", "1 ", "1-", "x-1"]) {
      expect(parseCourseRef(ref), ref).toBeUndefined();
    }
    expect(parseCourseRef("2147483648")).toBeUndefined();
  });

  test("reads what courseRef writes", () => {
    const urlLabelled = { number: 4732, urlLabel: urlLabel("Język polski") };
    expect(parseCourseRef(courseRef(urlLabelled))).toEqual(urlLabelled);
  });
});
