// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HtmlTagDescriptor } from "vite-plus";
import { expect, onTestFinished, test, vi } from "vite-plus/test";

import { BOOT, bootLanguage, bootScript } from "./boot.ts";
import { chooseLocale, LANGUAGE_STORAGE_KEY, preferredLocale } from "./index.tsx";
import { LOCALES } from "./locales.ts";

const apps = ["learn", "console"];

const indexHtml = (app: string) =>
  readFileSync(join(import.meta.dirname, "../../apps", app, "index.html"), "utf8");

/** `html` as `plugin` serves and builds it: the page, and the tags it adds. */
function transform(html: string, plugin = bootLanguage()) {
  const hook = plugin.transformIndexHtml as (html: string) => unknown;
  return hook(html) as { html: string; tags: HtmlTagDescriptor[] };
}

/**
 * `app`'s loading message as a browser preferring `languages` first paints it:
 * after `bootScript` ran in `<head>`, the copy the plugin's style leaves displayed.
 */
function boot(app: string, languages: string[]) {
  const { html, tags } = transform(indexHtml(app));
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  onTestFinished(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  document.documentElement.lang = "en";
  const style = tags.find(({ tag }) => tag === "style")!.children as string;
  document.head.innerHTML = `<style>${style}</style>`;
  // happy-dom runs no page script, so it runs here, as the page would.
  // oxlint-disable-next-line no-implied-eval
  new Function(bootScript())();
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .getElementById("boot")!.outerHTML;

  const shown = (part: string) => {
    const copies = [...document.querySelectorAll(`#boot [data-boot="${part}"] > [lang]`)];
    return copies.filter((copy) => getComputedStyle(copy).display !== "none");
  };
  const [loading, help, ...others] = [...shown("loading"), ...shown("help")];
  expect(others).toEqual([]);
  return {
    lang: document.documentElement.lang,
    copies: [loading?.getAttribute("lang"), help?.getAttribute("lang")],
    loading: loading?.textContent,
    help: help?.textContent,
    reload: help?.querySelector("a"),
  };
}

const said = (locale: keyof typeof BOOT) => ({
  loading: BOOT[locale].loading,
  help: BOOT[locale].help.before + BOOT[locale].help.reload + BOOT[locale].help.after,
});

test.each(apps)(
  "%s's loading message is English when no supported language is preferred",
  (app) => {
    for (const languages of [["de"], [], ["en-GB", "pl"], ["EN"], ["constructor"]]) {
      const page = boot(app, languages);
      expect(page).toMatchObject({ lang: "en", copies: ["en", "en"], ...said("en") });
      expect(page.lang).toBe(chooseLocale(languages));
    }
  },
);

test.each(apps)("%s's loading message follows the browser's first supported language", (app) => {
  for (const languages of [["pl-PL"], ["PL"], ["de-DE", "constructor", "pl", "en"]]) {
    const page = boot(app, languages);
    expect(page).toMatchObject({ lang: "pl", copies: ["pl", "pl"], ...said("pl") });
    expect(page.lang).toBe(chooseLocale(languages));
    // A link reloading the page.
    expect(page.reload!.getAttribute("href")).toBe("");
  }
});

test.each(apps)("%s's loading message follows a language chosen from the menu first", (app) => {
  onTestFinished(() => localStorage.clear());
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "pl");
  expect(boot(app, ["en-GB"]).lang).toBe("pl");
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
  const page = boot(app, ["pl-PL"]);
  expect(page).toMatchObject({ lang: "en", copies: ["en", "en"], loading: BOOT.en.loading });
  expect(page.lang).toBe(preferredLocale(["pl-PL"]));
});

test.each(apps)("%s's loading message is in each supported language's own words", (app) => {
  for (const locale of LOCALES) {
    expect(boot(app, [locale])).toMatchObject({
      lang: locale,
      copies: [locale, locale],
      ...said(locale),
    });
  }
});

test("the words are text, whatever characters they hold", () => {
  const loading = BOOT.en.loading;
  onTestFinished(() => void (BOOT.en.loading = loading));
  BOOT.en.loading = "<b>Loading</b> &amp; more";
  const { html } = transform(indexHtml("learn"));
  const copy = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector('[data-boot="loading"] > [lang="en"]')!;
  expect({ text: copy.textContent, elements: copy.children.length }).toEqual({
    text: "<b>Loading</b> &amp; more",
    elements: 0,
  });
});

test("a placeholder named twice, or not empty, fails the app's build", () => {
  const { html } = transform(indexHtml("learn"));
  expect(() => transform(html)).toThrow('data-boot="loading" once, on an empty element; has 1');
  const twice = indexHtml("learn").replace(
    "</body>",
    '<span data-boot="loading">Loading</span></body>',
  );
  expect(() => transform(twice)).toThrow('data-boot="loading" once, on an empty element; has 2');
});

test("the apps load the script from their own origin, never inline: the file a build emits, the dev server serves", () => {
  const plugin = bootLanguage();
  const { tags } = transform(indexHtml("learn"), plugin);
  expect(tags).toEqual([
    { tag: "script", attrs: { src: expect.stringMatching(/^\/assets\//) }, injectTo: "head" },
    { tag: "style", children: expect.stringContaining("display: none"), injectTo: "head" },
  ]);
  const src = (tags[0]!.attrs as { src: string }).src;

  const emitted: unknown[] = [];
  (plugin.generateBundle as (this: unknown) => void).call({
    emitFile: (file: unknown) => emitted.push(file),
  });
  expect(emitted).toEqual([{ type: "asset", fileName: src.slice(1), source: bootScript() }]);

  type Handle = (request: unknown, response: unknown) => void;
  const routes = new Map<string, Handle>();
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: { use: (path: string, handle: Handle) => routes.set(path, handle) },
  });
  const response = { type: "", body: "" };
  routes.get(src)!(undefined, {
    setHeader: (name: string, value: string) => name === "Content-Type" && (response.type = value),
    end: (body: string) => (response.body = body),
  });
  expect(response).toEqual({ type: "text/javascript", body: bootScript() });
});
