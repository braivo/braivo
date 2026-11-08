// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Site } from "./brand.ts";

/**
 * `BRAIVO_DOCS_BASE`, where the site sits (ADR 0057), as every part of the
 * build takes it: one path, starting and ending with `/`. A host, a query, or a
 * step up is refused, failing the build rather than publishing broken links.
 */
export function docsBase(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const segments = trimmed.split("/").filter(Boolean);
  // Decoded, as a browser resolves `%2e%2e` to `..`.
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "..";
    }
  });
  if (
    trimmed.startsWith("//") ||
    /[?#:\\]/.test(trimmed) ||
    decoded.some((segment) => segment === "." || segment === ".." || segment.includes("/"))
  ) {
    throw new Error(
      `BRAIVO_DOCS_BASE must be a path, such as /help/, not ${JSON.stringify(value)}.`,
    );
  }
  return segments.length ? `/${segments.join("/")}/` : "/";
}

/**
 * `BRAIVO_DOCS_BRAND`, the directory to brand the site from in place of
 * `fallback` (ADR 0057): its `site.ts`, the name, links, and head tags, and its
 * `brand.css`. One missing either fails the build, naming what is missing. An
 * absolute path, as a relative one would be read from `apps/docs`, where the
 * build runs, not from where it was started.
 */
export function brandDirectory(value: string | undefined, fallback: string): string {
  const dir = value?.trim();
  if (!dir) return fallback;
  if (!isAbsolute(dir)) {
    throw new Error(`BRAIVO_DOCS_BRAND must be an absolute path, not ${JSON.stringify(value)}.`);
  }
  for (const file of ["site.ts", "brand.css"]) {
    if (!existsSync(join(dir, file))) {
      throw new Error(`BRAIVO_DOCS_BRAND names ${dir}, which has no ${file}.`);
    }
  }
  return dir;
}

/**
 * `BRAIVO_DOCS_URL`, the site's public origin (ADR 0057), such as
 * `https://docs.example`: with it, each page names its canonical address, the
 * Markdown exports link absolutely, and the build writes `sitemap.xml` at the
 * base; without it, no address and no sitemap, rather than guess a host. An
 * origin alone, as the base gives the path.
 */
export function docsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `BRAIVO_DOCS_URL must be an http or https origin, such as https://docs.example, not ${JSON.stringify(value)}.`,
    );
  }
  return url.origin;
}

/** The brand's `site.ts`, with the one field every brand needs, its name, else the build fails naming it. */
export async function brandSite(dir: string): Promise<Site> {
  const module = (await import(pathToFileURL(join(dir, "site.ts")).href)) as {
    default?: Partial<Site>;
  };
  const site = module.default;
  if (typeof site?.name !== "string" || !site.name.trim()) {
    throw new Error(`BRAIVO_DOCS_BRAND's ${join(dir, "site.ts")} exports no name.`);
  }
  return site as Site;
}
