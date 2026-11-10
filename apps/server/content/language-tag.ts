// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A language tag in its canonical BCP 47 form — `es-mx` becomes `es-MX` — or
 * nothing when it is not one. Canonical so that two spellings of one language
 * are one value to filter and grade by.
 *
 * The primary subtag must have two or three letters, the shape of an ISO 639
 * code. `Intl` checks syntax only, and BCP 47's syntax admits a five-to-eight-
 * letter language subtag that no registered language uses — so `Spanish`, the
 * mistake a person is likeliest to make, would otherwise pass as a language.
 * Registration itself is not checked: `xx` passes. The registry Braivo could
 * check against is ICU's, and refusing a real language ICU lacks would be
 * worse than storing a code nobody uses.
 */
export function parseLanguageTag(value: string): string | undefined {
  // RFC 5646's suggested buffer: room for any language, script, and region.
  if (value.length > 35) return undefined;

  let tag: string | undefined;
  try {
    [tag] = Intl.getCanonicalLocales(value.trim());
  } catch {
    return undefined;
  }
  return tag !== undefined && /^[a-z]{2,3}(-|$)/.test(tag) ? tag : undefined;
}
