// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { expect, onTestFinished, test, vi } from "vite-plus/test";

import {
  activateLocale,
  chooseLanguage,
  chooseLocale,
  LANGUAGE_STORAGE_KEY,
  preferredLocale,
} from "./index.tsx";
import { LOCALES } from "./locales.ts";

test("chooses the browser's most preferred language Braivo supports, else English", () => {
  expect(chooseLocale(["pl-PL"])).toBe("pl");
  expect(chooseLocale(["PL"])).toBe("pl");
  expect(chooseLocale(["de-DE", "pl", "en"])).toBe("pl");
  expect(chooseLocale(["en-GB", "pl"])).toBe("en");
  expect(chooseLocale(["de"])).toBe("en");
  expect(chooseLocale([])).toBe("en");
});

test("shows a language's catalog, and says which it is to the document", async () => {
  onTestFinished(() => activateLocale("en"));
  await activateLocale("pl");

  expect(i18n.locale).toBe("pl");
  expect(document.documentElement.lang).toBe("pl");
  expect(i18n._(msg`Sign in`)).toBe("Zaloguj się");
});

test("prefers a language chosen from the menu, kept for later visits, over the browser's", async () => {
  onTestFinished(async () => {
    localStorage.clear();
    vi.restoreAllMocks();
    await activateLocale("en");
  });
  expect(preferredLocale(["pl-PL"])).toBe("pl");

  await chooseLanguage("en");
  expect(i18n.locale).toBe("en");
  expect(preferredLocale(["pl-PL"])).toBe("en");
  await chooseLanguage("pl");
  expect(i18n.locale).toBe("pl");
  expect(preferredLocale(["en-GB"])).toBe("pl");

  // One Braivo no longer supports, or storage that cannot be read, is no choice.
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
  expect(preferredLocale(["pl"])).toBe("pl");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  expect(preferredLocale(["en"])).toBe("en");
});

test("keeps a language only once it is shown, so a catalog that failed never starts a visit", async () => {
  onTestFinished(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  vi.spyOn(i18n, "loadAndActivate").mockImplementation(() => {
    throw new Error("Catalog failed");
  });

  await expect(chooseLanguage("pl")).rejects.toThrow("Catalog failed");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
});

test("shows and keeps the language chosen last, whichever catalog arrives first", async () => {
  onTestFinished(async () => {
    localStorage.clear();
    await activateLocale("en");
  });

  // Both catalogs come with the app, so Polish, chosen first, arrives first;
  // English, chosen after, still wins.
  const polish = chooseLanguage("pl");
  await chooseLanguage("en");
  await polish;

  expect(i18n.locale).toBe("en");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
});

// A catalog fetched at start-up strands its readers on the loading message
// whenever the fetch fails, a deploy having replaced its file among them.
// Static imports are bundled into the app, which a test of messages alone cannot tell apart.
test("imports every supported language's catalog statically, so none is fetched", () => {
  const source = readFileSync(join(import.meta.dirname, "index.tsx"), "utf8");
  for (const locale of LOCALES) {
    expect(source).toMatch(
      new RegExp(`^import \\{ messages as \\w+ \\} from "\\./locales/${locale}\\.po";$`, "m"),
    );
  }
  expect(source).not.toMatch(/\bimport\(/);
});
