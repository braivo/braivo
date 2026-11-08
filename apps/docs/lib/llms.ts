// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { llms } from "fumadocs-core/source";

import site from "#brand/site.ts";

import { base } from "./base.ts";
import { publishedMarkdown } from "./page-links.ts";
import { source } from "./source.ts";

type Page = ReturnType<typeof source.getPages>[number];

/** `BRAIVO_DOCS_URL`, the origin: with it, every address the exports give is absolute. */
const origin = import.meta.env.SITE;

/** An address from the base, absolute with an origin, else from its root. */
const address = (path: string) => (origin ? new URL(path, origin).href : path);

/**
 * Where a page's Markdown copy sits: beside its HTML, inside the two paths the
 * site occupies (ADR 0057), at its file's path under `content/`. A section's
 * index, `docs/index.mdx`, is `docs/index.md`, as `docs.md` would sit outside.
 */
export const markdownPath = (page: Page) => page.path.replace(/\.mdx$/, ".md");

/** The site as Markdown for AI tools: `docs/llms.txt`, `docs/llms-full.txt`, and each page's copy. */
export const docsLlms = llms(source, {
  // The index's heading, the brand's name, in place of Fumadocs' "Docs".
  renderName: (node, ctx) =>
    node.type === undefined || node.type === "root"
      ? site.name
      : ((node.type === "page" ? source.getNodePage(node, ctx.lang)?.data.title : undefined) ??
        (typeof node.name === "string" ? node.name : "")),
  renderUrl: (item, ctx) => {
    const page = source.getNodePage(item, ctx.lang);
    return page ? address(`${base}${markdownPath(page)}`) : item.url;
  },
  renderPage: async (page) => {
    const text = publishedMarkdown(await page.data.getText("processed"), page.path, base, origin);
    const description = page.data.description ? `> ${page.data.description}\n\n` : "";
    return `# ${page.data.title} (${address(page.url)})\n\n${description}${text}`;
  },
});
