// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test } from "vite-plus/test";

import { appPageToReturnTo, rememberAppPage } from "./app-page.ts";

afterEach(() => sessionStorage.clear());

test.each([
  "/example",
  "/example#courses",
  "/example?view=list",
  "/example/courses/c1?tab=overview#learners",
])("returns to the organization's page remembered: %s", (href) => {
  rememberAppPage(href);
  expect(appPageToReturnTo("example")).toBe(href);
});

test.each([
  ["nothing remembered", undefined],
  ["another organization's page", "/annex/sources"],
  ["one whose slug merely starts the same", "/example-two/sources"],
  ["a page outside any organization", "/organizations"],
])("opens the organization's home for %s", (_case, href) => {
  if (href) rememberAppPage(href);
  expect(appPageToReturnTo("example")).toBe("/example");
});

test("never remembers a settings page, keeping the one before", () => {
  rememberAppPage("/example/sources");
  for (const href of ["/example/settings", "/example/settings/general", "/example/settings?x=1"]) {
    rememberAppPage(href);
  }
  expect(appPageToReturnTo("example")).toBe("/example/sources");
});
