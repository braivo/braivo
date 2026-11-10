// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { resolveLanguageTag } from "./languages.ts";

test("takes a language named in full as its tag, and any other as typed", () => {
  // Where a browser shows tags alone (iOS Safari), the name typed in full.
  expect(resolveLanguageTag("sPaNiSh")).toBe("es");
  expect(resolveLanguageTag("Polish")).toBe("pl");
  // Any language with a two-letter tag, not only those suggested.
  expect(resolveLanguageTag("Czech")).toBe("cs");
  // A name two tags share, one deprecated: the current one.
  expect(resolveLanguageTag("Romanian")).toBe("ro");
  // `ak`, never `tw`, which some engines also name Akan.
  expect(resolveLanguageTag("Akan")).toBe("ak");
  expect(resolveLanguageTag("es-MX")).toBe("es-MX");
  // Named, though only a three-letter tag says it.
  expect(resolveLanguageTag("Filipino")).toBe("fil");
  // Not one it knows: Braivo's refusal says why.
  expect(resolveLanguageTag("Spansh")).toBe("Spansh");
});
