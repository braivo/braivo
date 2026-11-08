// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from "vite-plus/test";

import { lastUsed, rememberLastUsed } from "./last-used.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("remembers each account's last area apart (ADR 0059)", () => {
  rememberLastUsed("ada", { area: "console", organizationId: "fernwood" });
  rememberLastUsed("bob", { area: "learning" });

  expect(lastUsed("ada")).toEqual({ area: "console", organizationId: "fernwood" });
  expect(lastUsed("bob")).toEqual({ area: "learning" });
  expect(lastUsed("cyd")).toBeUndefined();

  rememberLastUsed("ada", { area: "learning" });
  expect(lastUsed("ada")).toEqual({ area: "learning" });
});

test("forgets what it cannot read, and storage it cannot reach, without failing", () => {
  localStorage.setItem("braivo.lastUsed.ada", "{");
  expect(lastUsed("ada")).toBeUndefined();
  localStorage.setItem("braivo.lastUsed.ada", JSON.stringify({ area: "console" }));
  expect(lastUsed("ada")).toBeUndefined();

  const unavailable = () => {
    throw new DOMException("denied", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: unavailable, setItem: unavailable });
  expect(() => rememberLastUsed("ada", { area: "learning" })).not.toThrow();
  expect(lastUsed("ada")).toBeUndefined();
});
