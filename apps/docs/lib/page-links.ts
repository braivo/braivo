// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

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
      const route = assetRoute(node.url, from(ctx.fileURL), base);
      if (route) ctx.setProperty(node, "url", route);
    },
  };
}
