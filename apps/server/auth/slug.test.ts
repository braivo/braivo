// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { slugProblem } from "./slug.ts";

describe("slugProblem", () => {
  // `signup` among them: an emailed code makes accounts, so no route takes it (ADR 0018).
  test.each(["acme", "italian-a1", "2026-cohort", "signup", "organizations", "a".repeat(63)])(
    "allows %s",
    (slug) => {
      expect(slugProblem(slug)).toBeUndefined();
    },
  );

  test.each(["api", "assets", "c", "invitations", "join", "learn", "login", "mcp"])(
    "refuses the reserved %s",
    (slug) => {
      expect(slugProblem(slug)).toContain("reserved");
    },
  );

  // An app's route missing from the list would be shadowed by `/<slug>`, or shadow it: the
  // console's, and the learn app's, which the installation's origin serves too (ADR 0059).
  // The generated trees are current: a route file absent from one fails `vp check`.
  test.each([
    ["console", "login"],
    ["learn", "c"],
  ])("reserves every root-level %s route", async (app, known) => {
    const routeTree = await Bun.file(
      new URL(`../../${app}/routeTree.gen.ts`, import.meta.url),
    ).text();
    const roots = [...routeTree.matchAll(/fullPath: '\/([^/'$]+)/g)].map((match) => match[1]);
    expect(roots).toContain(known);
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
