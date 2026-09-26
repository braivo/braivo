// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { slugProblem } from "./slug.ts";

describe("slugProblem", () => {
  test.each(["acme", "italian-a1", "2026-cohort", "a".repeat(63)])("allows %s", (slug) => {
    expect(slugProblem(slug)).toBeUndefined();
  });

  test.each(["api", "assets", "invitations", "login", "organizations", "signup"])(
    "refuses the reserved %s",
    (slug) => {
      expect(slugProblem(slug)).toContain("reserved");
    },
  );

  // A console route missing from the list would be shadowed by `/<slug>`, or shadow it.
  // The generated tree is current: a route file absent from it fails `vp check`.
  test("reserves every root-level console route", async () => {
    const routeTree = await Bun.file(
      new URL("../../console/routeTree.gen.ts", import.meta.url),
    ).text();
    const roots = [...routeTree.matchAll(/fullPath: '\/([^/'$]+)/g)].map((match) => match[1]);
    expect(roots).toContain("login");
    expect(roots.filter((root) => !slugProblem(root as string)?.includes("reserved"))).toEqual([]);
  });

  test.each([
    "",
    "Login",
    "acme school",
    "-acme",
    "acme-",
    "acme--school",
    "école",
    "a".repeat(64),
  ])("refuses the malformed %j", (slug) => {
    expect(slugProblem(slug)).toContain("lowercase");
  });
});
