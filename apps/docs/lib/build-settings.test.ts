// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { brandDirectory, docsBase } from "./build-settings.ts";

describe("docsBase", () => {
  test("is the root when unset or empty", () => {
    expect(docsBase(undefined)).toBe("/");
    expect(docsBase("")).toBe("/");
    expect(docsBase("/")).toBe("/");
  });

  test("starts and ends with a slash, however written", () => {
    expect(docsBase("/help/")).toBe("/help/");
    expect(docsBase("help")).toBe("/help/");
    expect(docsBase(" /school/help ")).toBe("/school/help/");
  });

  test("refuses a host, a query, or a step up", () => {
    for (const value of ["https://example.com/help/", "/help?x=1", "/a/../b/", "//help/"]) {
      expect(() => docsBase(value)).toThrow("BRAIVO_DOCS_BASE");
    }
  });
});

describe("brandDirectory", () => {
  const fallback = "/apps/docs/brand";

  test("is the neutral brand when unset", () => {
    expect(brandDirectory(undefined, fallback)).toBe(fallback);
  });

  test("is a directory holding site.ts and brand.css", () => {
    const dir = mkdtempSync(join(tmpdir(), "braivo-brand-"));
    try {
      expect(() => brandDirectory(dir, fallback)).toThrow("BRAIVO_DOCS_BRAND");
      writeFileSync(join(dir, "site.ts"), "export default {};\n");
      expect(() => brandDirectory(dir, fallback)).toThrow("brand.css");
      writeFileSync(join(dir, "brand.css"), "");
      expect(brandDirectory(dir, fallback)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a directory that is not there", () => {
    expect(() => brandDirectory("/nowhere/brand", fallback)).toThrow("/nowhere/brand");
  });
});

describe("the neutral build", () => {
  const app = fileURLToPath(new URL("..", import.meta.url));
  // Written apart, so this file does not name it.
  const hosted = ["braivo", "app"].join(".");
  const skipped = new Set(["content", "dist", "node_modules", ".astro", "screenshots"]);

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (skipped.has(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
  }

  test("names no hosted installation in apps/docs's code or configuration, its content aside", () => {
    const naming = files(app)
      .filter((path) => /\.(ts|tsx|astro|css|json|mjs|js|svg)$|_headers$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes(hosted))
      .map((path) => relative(app, path));
    expect(naming).toEqual([]);
  });
});
