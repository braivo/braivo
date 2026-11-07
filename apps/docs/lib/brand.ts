// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a brand's `site.ts` exports by default (ADR 0057): `apps/docs/brand/`
 * is the neutral one, and `BRAIVO_DOCS_BRAND` names a directory to use instead.
 */
export interface Site {
  /** The site's name: the navigation's title, and each tab's title after the page's. */
  name: string;
  /** A repository the navigation links to, if any. */
  githubUrl?: string;
  /** More links in the navigation, such as back to a school's own site. */
  links?: { text: string; url: string }[];
  /**
   * HTML for every page's head, such as a site verification `<meta>`.
   * `public/_headers` lets a page load and send only to the site's own origin,
   * so a font goes in `brand.css`, `url()` to a file in the brand directory,
   * and a script, font, or analytics endpoint elsewhere needs the host to send
   * its own headers.
   */
  head?: string;
}
