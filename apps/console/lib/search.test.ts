// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { matchesQuery } from "./search.ts";

test("finds a name typed without its accents or case, Polish ł included", () => {
  expect(matchesQuery("Łucja Wiśniewska", "lucja wisniewska", "pl")).toBe(true);
  expect(matchesQuery("Paweł", "PAWEL", "pl")).toBe(true);
  expect(matchesQuery("Ana", "Lee", "pl")).toBe(false);
});
