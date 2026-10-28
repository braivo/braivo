// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Plugin } from "vite-plus";

import { LANGUAGE_STORAGE_KEY, LOCALES, type Locale } from "./locales.ts";

/**
 * The words of each app's `index.html` loading message (`#boot`): shown before
 * the app starts, so outside Lingui's catalogs, and all a learner sees if their
 * language's catalog fails to load (ADR 0035).
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
 * The script setting the page's language to the one `preferredLocale` would
 * choose, its rule restated as no module has loaded yet. Run in `<head>` before
 * the body is parsed, so the first paint shows `#boot` in that language.
 */
export function bootScript(): string {
  return `(() => {
  const locales = ${JSON.stringify(LOCALES)};
  let stored = null;
  try {
    stored = localStorage.getItem(${JSON.stringify(LANGUAGE_STORAGE_KEY)});
  } catch {}
  const locale = [stored || "", ...(navigator.languages || [])]
    .map((language) => language.split("-")[0].toLowerCase())
    .find((primary) => locales.includes(primary));
  document.documentElement.lang = locale || "en";
})();
`;
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const PARTS = {
  loading: (words: (typeof BOOT)[Locale]) => escapeHtml(words.loading),
  help: ({ help }: (typeof BOOT)[Locale]) =>
    `${escapeHtml(help.before)}<a href="">${escapeHtml(help.reload)}</a>${escapeHtml(help.after)}`,
};

/**
 * `html` with each `data-boot` element, empty and named once, holding its words
 * in every language, each marked with its own: the page's markup, `BOOT` its
 * words. Anything else fails the build rather than ship copy left untranslated.
 */
function bootCopy(html: string): string {
  for (const [part, words] of Object.entries(PARTS)) {
    const found = html.match(new RegExp(`\\sdata-boot="${part}"`, "g"))?.length ?? 0;
    const element = new RegExp(`(<(\\w+)[^>]*\\sdata-boot="${part}"[^>]*>)(</\\2>)`);
    if (found !== 1 || !element.test(html))
      throw new Error(
        `index.html needs data-boot="${part}" once, on an empty element; has ${found}`,
      );
    html = html.replace(element, (_, open: string, _tag, close: string) => {
      const copies = LOCALES.map(
        (locale) => `<span lang="${locale}">${words(BOOT[locale])}</span>`,
      );
      return open + copies.join("") + close;
    });
  }
  return html;
}

/** Shows each `data-boot` element's copy in the page's language alone, to sight and assistive technology alike. */
const BOOT_STYLE = `${LOCALES.map(
  (locale) => `html:not([lang|="${locale}"]) [data-boot] > [lang="${locale}"]`,
).join(",\n")} {
  display: none;
}
`;

/**
 * Writes `#boot`'s words into an app's `index.html` in every language, and
 * loads `bootScript` in its `<head>`, in development and in builds:
 * a blocking classic script from the app's origin, never inline, so the policy
 * in its `_headers` allows scripts from the origin alone, and so nothing paints
 * before it chose. Named by its content, as Vite names a build's other assets.
 * The style choosing the copy is inline, as `style-src` allows (ADR 0049).
 * Read once, when Vite loads its config: after editing this file, `BOOT`, or
 * `LOCALES`, restart the dev server, which keeps serving the old ones.
 */
export function bootLanguage(): Plugin {
  const source = bootScript();
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
  const fileName = `assets/boot-language-${hash}.js`;
  return {
    name: "braivo:boot-language",
    configureServer(server) {
      server.middlewares.use(`/${fileName}`, (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml: (html) => ({
      html: bootCopy(html),
      tags: [
        { tag: "script", attrs: { src: `/${fileName}` }, injectTo: "head" },
        { tag: "style", children: BOOT_STYLE, injectTo: "head" },
      ],
    }),
  };
}
