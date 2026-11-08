// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRoute, GetStaticPaths } from "astro";

import { source } from "#lib/source";

/**
 * `sitemap.xml` at the base, every page's canonical address, written only once
 * `BRAIVO_DOCS_URL` gives the site's origin (ADR 0057): without one, there is
 * no address to give. At the base, as a sitemap may list only what sits under
 * its own path, and `docs/` holds neither `guides/` nor `docs` itself. A host
 * sharing its origin leaves it unrouted and lists the pages in its own.
 */
export const getStaticPaths = (() =>
  import.meta.env.SITE ? [{ params: { sitemap: "sitemap" } }] : []) satisfies GetStaticPaths;

export const GET: APIRoute = ({ site }) => {
  const urls = source
    .getPages()
    .map((page) => `<url><loc>${new URL(page.url, site).href}</loc></url>`)
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "Content-Type": "application/xml" } },
  );
};
