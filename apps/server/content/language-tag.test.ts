// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { parseLanguageTag } from "./language-tag.ts";

describe("reading a language tag", () => {
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
