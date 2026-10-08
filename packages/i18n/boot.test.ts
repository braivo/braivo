// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, onTestFinished, test, vi } from "vite-plus/test";

import { BOOT, bootScript } from "./boot.ts";
import { chooseLocale } from "./index.tsx";

const apps = ["learn", "console"];

/** `app`'s `index.html` body after `bootScript` runs in a browser preferring `languages`. */
function boot(app: string, languages: string[]) {
  const html = readFileSync(join(import.meta.dirname, "../../apps", app, "index.html"), "utf8");
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .getElementById("boot")!.outerHTML;
  document.documentElement.lang = "en";
  const originalLink = document.querySelector("#boot a");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  onTestFinished(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });
  // happy-dom runs no inline script, so it runs here, as the page would.
  // oxlint-disable-next-line no-implied-eval
  new Function(bootScript())();

  const read = (part: string) =>
    document.querySelector(`#boot [data-boot="${part}"]`)!.textContent!.replace(/\s+/g, " ").trim();
  return {
    lang: document.documentElement.lang,
    loading: read("loading"),
    help: read("help"),
    reload: document.querySelector('#boot [data-boot="help"] a'),
    originalLink,
  };
}

const said = (locale: keyof typeof BOOT) => ({
  loading: BOOT[locale].loading,
  help: BOOT[locale].help.before + BOOT[locale].help.reload + BOOT[locale].help.after,
});

test.each(apps)("%s's loading message is the HTML's English, which BOOT.en repeats", (app) => {
  for (const languages of [["de"], [], ["en-GB", "pl"], ["EN"]]) {
    const page = boot(app, languages);
    expect({ lang: page.lang, loading: page.loading, help: page.help }).toEqual({
      lang: "en",
      ...said("en"),
    });
    expect(page.lang).toBe(chooseLocale(languages));
  }
});

test.each(apps)("%s's loading message follows the browser's first supported language", (app) => {
  for (const languages of [["pl-PL"], ["PL"], ["de-DE", "constructor", "pl", "en"]]) {
    const page = boot(app, languages);
    expect({ lang: page.lang, loading: page.loading, help: page.help }).toEqual({
      lang: "pl",
      ...said("pl"),
    });
    expect(page.lang).toBe(chooseLocale(languages));
    // The same link, still reloading the page.
    expect(page.reload).toBe(page.originalLink);
    expect(page.reload!.getAttribute("href")).toBe("");
  }
});

test("no copy can close the script it is inlined in", () => {
  expect(bootScript()).not.toContain("<");
});
