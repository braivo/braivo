// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What scrolls an organization's pages and its settings from md, in the
 * window's place there: the viewport of `PagePanel`'s `ScrollArea`, marked
 * `data-page-scroller`. The router
 * takes it back to the top on each page, as it does the window (`router.tsx`).
 */
export const PAGE_SCROLLER = '[data-page-scroller] > [data-slot="scroll-area-viewport"]';

/**
 * Reads the page's data again where it stands: the router takes each render
 * back to the top, a refresh's included, which would carry a phone away from
 * the action it just confirmed. Only for the same page; a new one starts at
 * the top.
 */
export async function refreshInPlace(router: { invalidate: () => Promise<unknown> }) {
  const scroller = document.querySelector(PAGE_SCROLLER);
  const [top, x, y] = [scroller?.scrollTop ?? 0, window.scrollX, window.scrollY];
  await router.invalidate();
  if (scroller?.isConnected) scroller.scrollTop = top;
  window.scrollTo(x, y);
}
