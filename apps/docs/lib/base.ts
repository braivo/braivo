// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the site sits, `BRAIVO_DOCS_BASE` as Astro took it, ending in `/`.
 * Alone in its module, so a browser island imports it without the content
 * collections `source.ts` reads.
 */
export const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
