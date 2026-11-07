// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { brandDirectory, brandSite, docsBase, docsUrl } from "./build-settings.ts";

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

  test("refuses a host, a query, or a step up, encoded or not", () => {
    for (const value of [
      "https://example.com/help/",
      "/help?x=1",
      "/a/../b/",
      "//help/",
      "/a/%2e%2e/help/",
      "/a/%2E./help/",
    ]) {
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

  test("refuses a relative path, which would be read from apps/docs, not where the build started", () => {
    for (const value of ["brand", "./brand", "../school-brand"]) {
      expect(() => brandDirectory(value, fallback)).toThrow("must be an absolute path");
    }
  });

  test("fails on a directory that is not there", () => {
    expect(() => brandDirectory("/nowhere/brand", fallback)).toThrow("/nowhere/brand");
  });
});

describe("docsUrl", () => {
  test("is no origin when unset or empty", () => {
    expect(docsUrl(undefined)).toBeUndefined();
    expect(docsUrl(" ")).toBeUndefined();
  });

  test("is an http or https origin, its slash dropped", () => {
    expect(docsUrl("https://docs.example/")).toBe("https://docs.example");
    expect(docsUrl("http://localhost:4321")).toBe("http://localhost:4321");
  });

  test("refuses a path, a query, credentials, or another scheme", () => {
    for (const value of [
      "https://docs.example/help/",
      "https://docs.example/?x=1",
      "https://user:secret@docs.example",
      "ftp://docs.example",
      "docs.example",
    ]) {
      expect(() => docsUrl(value)).toThrow("BRAIVO_DOCS_URL");
    }
  });
});

describe("brandSite", () => {
  test("is the brand's site, with a name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "braivo-brand-"));
    try {
      writeFileSync(join(dir, "site.ts"), 'export default { name: "Fernwood Help" };\n');
      expect((await brandSite(dir)).name).toBe("Fernwood Help");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a brand without a name, naming the brand", async () => {
    for (const site of ["export default {};\n", 'export default { name: "  " };\n']) {
      const dir = mkdtempSync(join(tmpdir(), "braivo-brand-"));
      try {
        writeFileSync(join(dir, "site.ts"), site);
        await expect(brandSite(dir)).rejects.toThrow(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
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

test("the docs settings come from the build's own environment, never the env files", () => {
  const config = readFileSync(
    fileURLToPath(new URL("../astro.config.ts", import.meta.url)),
    "utf8",
  );
  for (const name of ["BRAIVO_DOCS_BASE", "BRAIVO_DOCS_URL", "BRAIVO_DOCS_BRAND"]) {
    expect(config).toContain(`process.env.${name}`);
  }
  expect(config).not.toMatch(/(?<!process\.)\benv\.BRAIVO_DOCS_/);
});
