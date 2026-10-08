// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Plugin } from "vite-plus";

import type { Locale } from "./locales.ts";

/**
 * The words of each app's `index.html` loading message (`#boot`): shown before
 * the app starts, so outside Lingui's catalogs, and all a learner sees if their
 * language's catalog fails to load (ADR 0035). English is the HTML as written.
 */
export const BOOT: Record<
  Locale,
  { loading: string; help: { before: string; reload: string; after: string } }
> = {
  en: {
    loading: "Loading",
    help: { before: "Still loading? Check your connection, then ", reload: "reload", after: "." },
  },
  pl: {
    loading: "Ładowanie",
    help: {
      before: "Nadal się ładuje? Sprawdź połączenie, a potem ",
      reload: "odśwież stronę",
      after: ".",
    },
  },
};

/**
 * The inline script rewriting `#boot` in the language `chooseLocale` would
 * choose, its rule restated as no module has loaded yet. It runs as the page is
 * parsed, before the app's module script.
 */
export function bootScript(): string {
  // `<` escaped, so no string can close the script element.
  const copy = JSON.stringify(BOOT).replaceAll("<", "\\u003c");
  return `(() => {
  const copy = ${copy};
  const locale = (navigator.languages || [])
    .map((language) => language.split("-")[0].toLowerCase())
    .find((primary) => Object.hasOwn(copy, primary));
  if (locale === undefined || locale === "en") return;
  const { loading, help } = copy[locale];
  document.documentElement.lang = locale;
  document.querySelector('#boot [data-boot="loading"]').textContent = loading;
  const paragraph = document.querySelector('#boot [data-boot="help"]');
  const link = paragraph.querySelector("a");
  link.textContent = help.reload;
  paragraph.replaceChildren(help.before, link, help.after);
})();`;
}

/** Adds `bootScript` to the end of an app's `index.html`, in development and in builds. */
export function bootLanguage(): Plugin {
  return {
    name: "braivo:boot-language",
    transformIndexHtml: () => [{ tag: "script", children: bootScript(), injectTo: "body" }],
  };
}
