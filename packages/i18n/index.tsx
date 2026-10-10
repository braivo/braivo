// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The language an app shows its copy in, chosen when it starts and changeable
// after, and the catalogs it comes from (docs/adr/0035-lingui-localization.md).
// Copy is marked where it is rendered, with Lingui's macros, and extracted by
// `lingui.config.ts`.

import { i18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";

import { LANGUAGE_STORAGE_KEY, type Locale, LOCALES, supportedLocale } from "./locales.ts";
import { messages as english } from "./locales/en.po";

export { LANGUAGE_STORAGE_KEY, type Locale, LOCALES };

/**
 * Each language by its own name, as a menu of languages lists it: the name a
 * reader of that language looks for, whatever the page's language.
 */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", pl: "Polski" };

/** English, the fallback, comes with the app; another language is fetched once chosen. */
const catalogs: Record<Locale, () => Promise<{ messages: Messages }>> = {
  en: async () => ({ messages: english }),
  pl: () => import("./locales/pl.po"),
};

/**
 * The first of the browser's languages, most preferred first, that Braivo
 * supports, matched by its primary subtag (`pl-PL` is `pl`); else English.
 */
export function chooseLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const locale = supportedLocale(language);
    if (locale) return locale;
  }
  return "en";
}

/**
 * The language chosen from a menu, if one was and Braivo still supports it,
 * else `chooseLocale`'s. Storage that cannot be read is no choice.
 */
export function preferredLocale(languages: readonly string[]): Locale {
  try {
    const stored = supportedLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? "");
    if (stored) return stored;
  } catch {
    // Blocked by policy, say: the browser's languages decide.
  }
  return chooseLocale(languages);
}

/** Counts menu choices, so only the last one's catalog is shown. */
let choices = 0;

/**
 * Shows `locale` now, and keeps it as the choice for every later visit: only
 * once shown, so a catalog that failed to load is never what the next visit
 * starts with. A choice made while its catalog loaded supersedes it, whichever
 * arrives first: it then neither shows nor rejects. Else rejects as
 * `activateLocale` does.
 */
export async function chooseLanguage(locale: Locale) {
  const choice = ++choices;
  let messages: Messages;
  try {
    ({ messages } = await catalogs[locale]());
  } catch (error) {
    if (choice === choices) throw error;
    return;
  }
  if (choice !== choices) return;
  show(locale, messages);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Unsaved, it still holds for this page.
  }
}

/** Loads `locale`'s catalog and shows it, setting the document's language. */
export async function activateLocale(locale: Locale) {
  const { messages } = await catalogs[locale]();
  show(locale, messages);
}

function show(locale: Locale, messages: Messages) {
  i18n.loadAndActivate({ locale, messages });
  document.documentElement.lang = locale;
}

/** Lingui's provider, around a whole app; it renders nothing until a locale is active. */
export function LocalizationProvider({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
