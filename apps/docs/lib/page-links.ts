// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import type { MdastPluginDefinition } from "satteri";

/**
 * A page's link to another page is relative, to its file, so it also works on
 * GitHub (ADR 0057). Returns the route of the page `href` names from the page
 * at `from`, both under `content/`, fragment kept; `undefined` for anything else.
 */
export function pageRoute(href: string, from: string, base: string): string | undefined {
  const match = /^(\.{1,2}\/[^#?]*)\.mdx(#.*)?$/.exec(href);
  if (!match) return undefined;
  const page = posix.normalize(posix.join(posix.dirname(from), match[1]!));
  if (page.startsWith("../")) return undefined;
  const route = page.replace(/(^|\/)index$/, "");
  return `${base.replace(/\/?$/, "/")}${route}${match[2] ?? ""}`;
}

/** Where the site serves the file in `public/` that `href` names from the page at `from`. */
export function assetRoute(href: string, from: string, base: string): string | undefined {
  if (!href.startsWith("../")) return undefined;
  const file = posix.normalize(posix.join(posix.dirname(from), href));
  if (!file.startsWith("../public/")) return undefined;
  return `${base.replace(/\/?$/, "/")}${file.slice("../public/".length)}`;
}

/**
 * A screenshot's size on the page: half its pixels, as the capture takes them
 * at device scale 2 (tooling/docs-screenshots/capture.ts). Set on the image, a
 * small crop shows at its size instead of stretched to the column, and the
 * page keeps its place while it loads. `undefined` for any other file.
 */
export function screenshotSize(file: string): { width: number; height: number } | undefined {
  if (!/\/docs\/screenshots\/.+\.png$/.test(file)) return undefined;
  // A PNG's width and height, big-endian, follow its signature and IHDR's header.
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0) / 2, height: header.readUInt32BE(4) / 2 };
}

/** Rewrites each page's links and images into where the site serves them, as it compiles. */
export function pageLinks(contentDir: string, base: string): MdastPluginDefinition {
  const from = (fileURL: URL) => posix.relative(contentDir, fileURLToPath(fileURL));
  return {
    name: "page-links",
    link(node, ctx) {
      if (!ctx.fileURL) return;
      const route = pageRoute(node.url, from(ctx.fileURL), base);
      if (route) ctx.setProperty(node, "url", route);
    },
    image(node, ctx) {
      if (!ctx.fileURL) return;
      const page = from(ctx.fileURL);
      const route = assetRoute(node.url, page, base);
      if (!route) return;
      ctx.setProperty(node, "url", route);
      const size = screenshotSize(posix.join(contentDir, posix.dirname(page), node.url));
      if (size) ctx.setProperty(node, "data", { hProperties: size });
    },
  };
}
