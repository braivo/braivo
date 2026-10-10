// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The languages Braivo's copy is in, English first: the source and the fallback
 * (ADR 0035). Apart from `index.tsx`, so the server and `lingui.config.ts` read
 * it without React or catalogs.
 */
export const LOCALES = ["en", "pl"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Where a language chosen from a menu is kept, per browser and origin; the
 * loading message (`boot.ts`) reads it too, before any module loads.
 */
export const LANGUAGE_STORAGE_KEY = "braivo-language";

/** The supported language a language tag names by its primary subtag (`pl-PL` is `pl`), if any. */
export function supportedLocale(tag: string): Locale | undefined {
  const primary = tag.split("-")[0]!.toLowerCase();
  return LOCALES.find((locale) => locale === primary);
}
