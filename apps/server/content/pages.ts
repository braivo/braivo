// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { codePoints, partAt } from "./locator.ts";
import { normalizeSourceText } from "./source.ts";

/** One page of a document: its label as printed — `12`, `iv` — and its text. */
export type Page = { page: string; text: string };

/**
 * Where each page begins in a document's text, in code points, and its label:
 * what lets a passage cited from a book name the page it is on
 * (docs/adr/0026-paged-documents.md). Ordered by `start`.
 */
export type Pagination = { start: number; page: string }[];

/** More pages than a school's longest book; a bound so a request cannot be all pages. */
const MAX_PAGES = 10_000;

/** Long enough for any printed page number, `xlviii` or `A-12`; short enough to caption. */
const MAX_LABEL = 16;

/**
 * A document's pages as a source's text — separated by a blank line, so a page
 * ends a paragraph — and the pagination that maps the text back to them, or
 * what is wrong with them. Each page's text is put in the form
 * `normalizeSourceText` gives a source and trimmed, so positions are final.
 *
 * Pages are kept in the order sent, and labels need not be ordered or unique:
 * front matter numbered `i`, `ii` comes before `1`, and a book may restart.
 * `problem` names the page by its index, as `joinCues` names a cue.
 */
export function joinPages(
  pages: readonly Page[],
): { text: string; pagination: Pagination } | { problem: string } {
  if (pages.length === 0 || pages.length > MAX_PAGES) {
    return { problem: `A document needs 1 to ${MAX_PAGES} pages` };
  }

  const texts: string[] = [];
  const pagination: Pagination = [];
  let start = 0;
  for (const [index, { page: sent, text: content }] of pages.entries()) {
    // In NFC, as the text is, so the same label always hashes the same, and
    // counted so: a letter sent with its accent apart is still one.
    const page = sent.trim().normalize("NFC");
    if (
      !page.isWellFormed() ||
      page === "" ||
      codePoints(page) > MAX_LABEL ||
      /\p{Cc}/u.test(page)
    ) {
      return {
        problem: `Page ${index} needs \`page\`: its label as printed, such as 12 or iv, of at most ${MAX_LABEL} characters`,
      };
    }
    const text = normalizeSourceText(content)?.trim();
    if (text === undefined || text === "") {
      return {
        problem: `Page ${index} has no text Braivo can store: it is blank, or carries a NUL or an unpaired surrogate; leave out a page without words`,
      };
    }

    texts.push(text);
    pagination.push({ start, page });
    // The blank line that follows, too.
    start += codePoints(text) + 2;
  }

  return { text: texts.join("\n\n"), pagination };
}

/** The label of the page `position` of a document's text is on. */
export function pageOf(pagination: Pagination, position: number): string | undefined {
  return partAt(pagination, position)?.page;
}
