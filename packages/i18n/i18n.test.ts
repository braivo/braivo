// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { expect, onTestFinished, test } from "vite-plus/test";

import { activateLocale, chooseLocale } from "./index.tsx";

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
