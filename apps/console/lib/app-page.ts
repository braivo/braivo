// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The last page outside settings, per tab, so leaving settings returns there,
 * as Linear's "Back to app" does. Kept in `sessionStorage`: a tab's own, and
 * still there after a reload. Storage that cannot be used remembers nothing.
 */
const KEY = "braivo-app-page";

/** `/<organization>/settings`, and any page below it. */
const SETTINGS = /^\/[^/?#]+\/settings(?:[/?#]|$)/;

/**
 * Remembers `href`, unless it is a settings page: while navigating there, the
 * location changes a render before the matches that tell settings apart do.
 */
export function rememberAppPage(href: string): void {
  if (SETTINGS.test(href)) return;
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    // Unremembered: leaving settings opens the organization instead.
  }
}

/**
 * Where leaving settings goes: the page remembered, if it was one of
 * `organizationSlug`'s, else that organization's home. Another
 * organization's page would leave the one whose settings these are.
 */
export function appPageToReturnTo(organizationSlug: string): string {
  const home = `/${organizationSlug}`;
  let remembered: string | null = null;
  try {
    remembered = sessionStorage.getItem(KEY);
  } catch {
    return home;
  }
  // The home itself, or what follows it at a boundary: a path, a query, or a
  // fragment, never a slug merely starting the same (`/example-two`).
  const rest = remembered?.startsWith(home) ? remembered.slice(home.length) : undefined;
  return rest !== undefined && /^(?:$|[/?#])/.test(rest) ? `${home}${rest}` : home;
}
