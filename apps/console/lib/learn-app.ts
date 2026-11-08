// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether `href`, a path on this origin, is Braivo's own learn app's, `/learn`
 * or `/c/…` (ADR 0059): another app, so reached by loading it, never by this
 * router, which would read `learn` or `c` as a slug.
 */
export function isLearnApp(href: string): boolean {
  return /^\/(?:learn|c)(?:[/?#]|$)/.test(href);
}
