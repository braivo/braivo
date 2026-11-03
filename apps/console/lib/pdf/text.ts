// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A page's text from pdf.js's items, and how far to trust it: pure, so it is
// tested without pdf.js or a browser (docs/adr/0055-pdf-text-in-the-browser.md).

/** A text item as pdf.js streams it: its string, baseline origin, size, and end of line. */
export type Item = { str: string; x: number; y: number; w: number; h: number; eol: boolean };

/** A rectangle in page units, origin at the page's lower left. */
export type Box = [x0: number, y0: number, x1: number, y1: number];

/**
 * A page's text in reading order as the content stream draws it: lines from
 * pdf.js's end-of-line flags or a moved baseline, joined by a space; a
 * paragraph breaks on a gap over 1.6 line heights, or a jump back up (a new
 * column). Columns drawn line by line across the page interleave: pdf.js does
 * no layout analysis, and the owner's review is where that shows.
 */
export function assemble(items: readonly Item[]): string {
  type Line = { text: string; y: number; h: number };
  const lines: Line[] = [];
  let line: Line | undefined;
  for (const item of items) {
    if (line && item.str.trim() && Math.abs(item.y - line.y) > Math.max(line.h, item.h, 1) / 2) {
      lines.push(line);
      line = undefined;
    }
    line ??= { text: "", y: item.y, h: item.h };
    line.text += item.str;
    line.h = Math.max(line.h, item.h);
    if (item.eol) {
      lines.push(line);
      line = undefined;
    }
  }
  if (line) lines.push(line);

  const paragraphs: string[] = [];
  let paragraph = "";
  let previous: Line | undefined;
  for (const next of lines) {
    const text = next.text.replace(/[ \t]+/g, " ").trim();
    if (!text) continue;
    const lead = previous ? previous.y - next.y : 0;
    const height = Math.max(previous?.h ?? 0, next.h, 1);
    if (!previous || lead > 1.6 * height || lead < -height) {
      if (paragraph) paragraphs.push(paragraph);
      paragraph = text;
    } else if (/[-‐]$/.test(paragraph)) {
      // A printed hyphen at a line's end is kept: "well-" "known" is one word,
      // and a hyphenated word cannot be told from a compound.
      paragraph += text;
    } else {
      paragraph += " " + text;
    }
    previous = next;
  }
  if (paragraph) paragraphs.push(paragraph);
  return normalize(paragraphs.join("\n\n"));
}

/**
 * NFC, with ligature characters (U+FB00–FB06) spelled out, so "ﬁnal" is
 * quoted as "final"; soft hyphens, zero-width spaces, and byte-order marks
 * removed. Nothing else is changed: the owner reviews what is kept.
 */
export function normalize(text: string): string {
  return text
    .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKD"))
    .replace(/[­​﻿]/g, "")
    .normalize("NFC");
}

/** What a page's text says about how it was made. */
export type TextFeatures = {
  /** Code points other than whitespace. */
  chars: number;
  /** Letters and digits. */
  alnum: number;
  /** U+FFFD, controls, private use, and unassigned code points: a font's codes, not text. */
  unreadable: number;
  /** The share of the page's rows (85, about 10 pt each) holding any text: how far down it spreads. */
  textRows: number;
};

/** How far a page's text is trusted: `failed` is a page pdf.js could not read. */
export type Outcome = "text" | "no-text" | "doubtful" | "failed";

/** The page's grid: 60 columns by 85 rows, each about 10 pt on A4 or Letter. */
const GRID = { columns: 60, rows: 85 };

/**
 * The share of the page `boxes` cover, their union on the grid; with `rows`,
 * the share of the grid's rows any box touches.
 */
export function coverage(
  boxes: readonly Box[],
  width: number,
  height: number,
  rows = false,
): number {
  if (boxes.length === 0 || width <= 0 || height <= 0) return 0;
  const { columns, rows: gridRows } = GRID;
  const grid = new Uint8Array(columns * gridRows);
  for (const [x0, y0, x1, y1] of boxes) {
    const left = Math.max(0, Math.floor((Math.min(x0, x1) / width) * columns));
    const right = Math.min(columns, Math.ceil((Math.max(x0, x1) / width) * columns));
    const bottom = Math.max(0, Math.floor((Math.min(y0, y1) / height) * gridRows));
    const top = Math.min(gridRows, Math.ceil((Math.max(y0, y1) / height) * gridRows));
    // Off the page, as cropped text is: nothing to fill, and a negative end
    // would make `fill` count from the grid's end.
    if (right <= left) continue;
    for (let row = bottom; row < top; row++)
      grid.fill(1, row * columns + left, row * columns + right);
  }
  if (rows) {
    let touched = 0;
    for (let row = 0; row < gridRows; row++) {
      if (grid.subarray(row * columns, (row + 1) * columns).includes(1)) touched++;
    }
    return touched / gridRows;
  }
  return grid.reduce((sum, cell) => sum + cell, 0) / grid.length;
}

export function textFeatures(
  text: string,
  textBoxes: readonly Box[],
  width: number,
  height: number,
): TextFeatures {
  let chars = 0;
  let alnum = 0;
  let unreadable = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    chars++;
    if (/[\p{L}\p{N}]/u.test(char)) alnum++;
    else if (/[�\p{Cc}\p{Co}\p{Cn}]/u.test(char)) unreadable++;
  }
  return { chars, alnum, unreadable, textRows: coverage(textBoxes, width, height, true) };
}

/**
 * The rule, frozen on calibration PDFs before held-out ones were made (ADR
 * 0055): a costly error is a scan passing as read, so doubtful wins a tie.
 */
export const RULE = {
  /** Over this share of unreadable code points: doubtful. */
  unreadableShare: 0.05,
  /** Images covering at least this share of the page make it look scanned… */
  scanImage: 0.3,
  /** …unless its text reaches this share of its rows, about five lines (a header-only scan: 0.024; an OCR layer: 0.129). */
  scanRows: 0.06,
};

/**
 * A page's outcome from its text, or `"needs-images"` when only how much of
 * the page images cover can decide: then call again with `imageCover`, the
 * share they cover, or -1 when it could not be told. Asking only then keeps an
 * ordinary PDF's images undecoded, the heavy part of reading one.
 */
export function classify(features: TextFeatures): Outcome | "needs-images";
export function classify(features: TextFeatures, imageCover: number): Outcome;
export function classify(features: TextFeatures, imageCover?: number): Outcome | "needs-images" {
  const { chars, alnum, unreadable, textRows } = features;
  if (chars === 0) return "no-text";
  if (alnum === 0 || unreadable > RULE.unreadableShare * chars) return "doubtful";
  if (textRows >= RULE.scanRows) return "text";
  if (imageCover === undefined) return "needs-images";
  if (imageCover < 0 || imageCover >= RULE.scanImage) return "doubtful";
  return "text";
}
