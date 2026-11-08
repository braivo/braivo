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
 * A page's processed Markdown with its links and images where the site serves
 * them, by the rules `pageLinks` applies to the HTML: Fumadocs slices that
 * Markdown from the authored source, so the plugin's AST changes never reach
 * it. A page link goes to its HTML page, which its anchors name. Paths start
 * at the origin's root, base included, so they hold in `llms-full.txt` beside
 * other pages' too; with `origin`, they are absolute.
 */
export function markdownLinks(
  markdown: string,
  from: string,
  base: string,
  origin?: string,
): string {
  return markdown.replace(/\]\(([^)\s]+)/g, (link, href: string) => {
    const route = pageRoute(href, from, base) ?? assetRoute(href, from, base);
    if (!route) return link;
    return `](${origin ? new URL(route, origin).href : route}`;
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A screenshot's size on the page: half its pixels. `public/docs/screenshots/`
 * holds only the capture's PNGs, taken at device scale 2
 * (tooling/docs-screenshots/capture.ts); a picture of any other scale goes
 * elsewhere, as a PNG cannot say its intended density. Set on the image, a
 * small crop shows at its size instead of stretched to the column, and the
 * page keeps its place while it loads. `undefined` for any other file; a
 * screenshot that is not such a PNG fails the build, naming it.
 */
export function screenshotSize(file: string): { width: number; height: number } | undefined {
  if (!/\/docs\/screenshots\/.+\.png$/.test(file)) return undefined;
  const bytes = readFileSync(file);
  // The signature, then the IHDR chunk: its length, type, width, and height.
  const valid =
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.toString("latin1", 12, 16) === "IHDR";
  const pixels = valid ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : [];
  if (pixels.length !== 2 || pixels.some((side) => side === 0 || side % 2 !== 0)) {
    throw new Error(`${file} is not a screenshot PNG at device scale 2: an even width and height.`);
  }
  return { width: pixels[0]! / 2, height: pixels[1]! / 2 };
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
