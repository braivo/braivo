// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether `text` holds what was typed, ignoring case and diacritics, Polish
 * `ł` included, which Unicode does not decompose.
 */
export function matchesQuery(text: string, query: string, locale: string): boolean {
  const fold = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[łŁ]/g, (letter) => (letter === "ł" ? "l" : "L"))
      .toLocaleLowerCase(locale);
  return fold(text).includes(fold(query.trim()));
}
