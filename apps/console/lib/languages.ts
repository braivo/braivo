// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { parseLanguageTag } from "@braivo/server/client";

/**
 * Suggested for a language, as the tag Braivo takes (sources-3, generation-6) with
 * its name: a teacher knows "Spanish", not `es`.
 */
export const SUGGESTED_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "pl",
  "uk",
  "nl",
  "sv",
  "zh",
  "ja",
  "ar",
];
export const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * Every two-letter tag by its English name, lowercase, as this browser names
 * it. Some list a suggestion's tag alone (iOS Safari), so a name typed in full
 * must work too, suggested or not. Deprecated tags canonicalize to the current
 * one (`mo` to `ro`); of two current tags an engine names alike (ICU 78: `ak`
 * and `tw`, "Akan"), the first, the macrolanguage, is kept.
 */
const TWO_LETTER_TAG_BY_NAME = (() => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const byName = new Map<string, string>();
  for (const first of letters) {
    for (const second of letters) {
      const tag = first + second;
      const name = languageNames.of(tag)?.toLowerCase();
      if (name && !byName.has(name)) {
        byName.set(name, Intl.getCanonicalLocales(tag)[0]!);
      }
    }
  }
  return byName;
})();
/**
 * The same for three-letter tags, such as `fil`, Filipino: a name a teacher may
 * well type. Built when a name is not found above, as naming them all takes a
 * noticeable moment and few need it.
 */
let threeLetterTagByName: Map<string, string> | undefined;
function threeLetterTagOf(name: string): string | undefined {
  if (!threeLetterTagByName) {
    threeLetterTagByName = new Map();
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (const first of letters) {
      for (const second of letters) {
        for (const third of letters) {
          const tag = first + second + third;
          const named = languageNames.of(tag)?.toLowerCase();
          if (named && !threeLetterTagByName.has(named)) {
            threeLetterTagByName.set(named, Intl.getCanonicalLocales(tag)[0]!);
          }
        }
      }
    }
  }
  return threeLetterTagByName.get(name);
}

/**
 * A language named in full as its tag; anything else as typed, for Braivo to
 * judge. A tag is taken as it is before three-letter names are looked through,
 * so `pt-BR` or `fil` never waits on naming them all.
 */
export const resolveLanguageTag = (typed?: string) => {
  if (!typed) return typed;
  const name = typed.toLowerCase();
  return (
    TWO_LETTER_TAG_BY_NAME.get(name) ??
    (parseLanguageTag(typed) ? typed : (threeLetterTagOf(name) ?? typed))
  );
};

/**
 * A tag as a field shows it: by name where the name leads back to the same tag,
 * else as the tag, since some names do not ("Brazilian Portuguese" for `pt-BR`),
 * and a form must never fill in what it would then refuse.
 */
export function languageFieldValue(tag: string): string {
  const name = languageNames.of(tag);
  const canonical = parseLanguageTag(tag);
  return name && canonical && parseLanguageTag(resolveLanguageTag(name)!) === canonical
    ? name
    : tag;
}
