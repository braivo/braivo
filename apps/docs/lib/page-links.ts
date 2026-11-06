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

/** Rewrites each page's links to other pages into their routes, as it compiles. */
export function pageLinks(contentDir: string, base: string): MdastPluginDefinition {
  return {
    name: "page-links",
    link(node, ctx) {
      if (!ctx.fileURL) return;
      const from = posix.relative(contentDir, fileURLToPath(ctx.fileURL));
      const route = pageRoute(node.url, from, base);
      if (route) ctx.setProperty(node, "url", route);
    },
  };
}
