// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What scrolls an organization's pages and its settings from md, in the
 * window's place there: the viewport of `PagePanel`'s `ScrollArea`, marked
 * `data-page-scroller`. The router
 * takes it back to the top on each page, as it does the window (`router.tsx`).
 */
export const PAGE_SCROLLER = '[data-page-scroller] > [data-slot="scroll-area-viewport"]';
