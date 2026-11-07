// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `BRAIVO_DOCS_BASE`, where the site sits (ADR 0057), as every part of the
 * build takes it: one path, starting and ending with `/`. A host, a query, or a
 * step up is refused, failing the build rather than publishing broken links.
 */
export function docsBase(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const segments = trimmed.split("/").filter(Boolean);
  if (
    trimmed.startsWith("//") ||
    /[?#:\\]/.test(trimmed) ||
    segments.some((segment) => segment === "." || segment === "..")
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
 * `brand.css`. One missing either fails the build, naming what is missing.
 */
export function brandDirectory(value: string | undefined, fallback: string): string {
  const dir = value?.trim();
  if (!dir) return fallback;
  for (const file of ["site.ts", "brand.css"]) {
    if (!existsSync(join(dir, file))) {
      throw new Error(`BRAIVO_DOCS_BRAND names ${dir}, which has no ${file}.`);
    }
  }
  return dir;
}
