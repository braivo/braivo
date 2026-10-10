// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

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

  // Polish's catalog is fetched; English's comes with the app, so it is shown first.
  const polish = chooseLanguage("pl");
  await chooseLanguage("en");
  await polish;

  expect(i18n.locale).toBe("en");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
});
