// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The language an app shows its copy in, chosen once when it starts, and the
// catalogs it comes from (docs/adr/0035-lingui-localization.md). Copy is marked
// where it is rendered, with Lingui's macros, and extracted by `lingui.config.ts`.

import { i18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";

import { type Locale, LOCALES, supportedLocale } from "./locales.ts";
import { messages as english } from "./locales/en.po";

export { type Locale, LOCALES };

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

/** Loads `locale`'s catalog and shows it, setting the document's language. */
export async function activateLocale(locale: Locale) {
  const { messages } = await catalogs[locale]();
  i18n.loadAndActivate({ locale, messages });
  document.documentElement.lang = locale;
}

/** Lingui's provider, around a whole app; it renders nothing until a locale is active. */
export function LocalizationProvider({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
