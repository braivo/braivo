// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Outcome, PdfPage } from "./read.ts";

/**
 * A page under the owner's review: its label and text as they will be saved,
 * and whether it is kept, `undefined` until they decide. A page read cleanly
 * starts kept; a flagged one waits for a decision, so nothing the reader
 * doubted is saved or left out unseen.
 */
export type ReviewedPage = {
  position: number;
  outcome: Outcome;
  /** The PDF's own label, if it has one, which a cleared offset returns to. */
  printed?: string;
  label: string;
  text: string;
  keep?: boolean;
};

/** Replaces the pages under review by what `change` makes of them. */
export type ChangeReview = (change: (pages: ReviewedPage[]) => ReviewedPage[]) => void;

export function startReview(pages: readonly PdfPage[]): ReviewedPage[] {
  return pages.map(({ position, label, outcome, text }) => ({
    position,
    outcome,
    printed: label,
    label: label ?? String(position),
    text,
    keep: outcome === "text" ? true : undefined,
  }));
}

/** The highest first page `braivo sources add --first-page` takes too (sources-18). */
const MAX_FIRST_PAGE = 999_999;

/**
 * The pages labelled from `first`, the printed number of the first page, as
 * typed: each the next number. Blank, labels return to the PDF's own, or to
 * positions; anything else that is not a number from 1 changes nothing.
 */
export function numberFrom(pages: readonly ReviewedPage[], first: string): ReviewedPage[] {
  if (first.trim() === "") {
    return pages.map((page) => ({ ...page, label: page.printed ?? String(page.position) }));
  }
  const number = Number(first);
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIRST_PAGE) return [...pages];
  return pages.map((page, index) => ({ ...page, label: String(number + index) }));
}

/** A control in the review a problem is about: a page's label, text, or decision. */
export type ReviewField = `page-${number}-${"label" | "text" | "keep"}`;

/**
 * What stops saving, the first in page order, as Braivo would refuse it
 * (sources-8): a page undecided, a kept page without words or with what
 * Braivo cannot store, a label it would refuse, or nothing kept.
 */
export function reviewProblem(
  pages: readonly ReviewedPage[],
): { message: string; field?: ReviewField } | undefined {
  for (const { position, label, text, keep } of pages) {
    if (keep === undefined) {
      return { message: `Keep page ${position} or leave it out.`, field: `page-${position}-keep` };
    }
    if (!keep) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) {
      return {
        message: `Page ${position} has no words to keep: paste its text, or leave it out.`,
        field: `page-${position}-text`,
      };
    }
    if (!text.isWellFormed() || text.includes("\0")) {
      return {
        message: `Page ${position}'s text has a character Braivo cannot store: delete it, or leave the page out.`,
        field: `page-${position}-text`,
      };
    }
    const printed = label.trim().normalize("NFC");
    if (
      printed === "" ||
      codePoints(printed) > 16 ||
      /\p{Cc}/u.test(printed) ||
      !printed.isWellFormed()
    ) {
      return {
        message: `Page ${position}'s printed page needs 1 to 16 characters, such as 12 or iv.`,
        field: `page-${position}-label`,
      };
    }
  }
  if (!pages.some((page) => page.keep)) return { message: "Keep at least one page." };
}

/** The kept pages as a paged source takes them (sources-8), in order. */
export function keptPages(pages: readonly ReviewedPage[]): { page: string; text: string }[] {
  return pages.filter((page) => page.keep).map(({ label, text }) => ({ page: label.trim(), text }));
}

/** Code points, as Braivo counts a label's length (sources-8). */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}
