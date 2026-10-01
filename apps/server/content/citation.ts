// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a quote sits in a source's text, in Unicode code points: `start` is the
 * position of its first character and `end` the position just past its last.
 * Code points rather than JavaScript's UTF-16 units, so that every client and
 * PostgreSQL's `substr` count the same way.
 */
export type QuoteLocation = { kind: "located"; start: number; end: number };

/**
 * Why a quote could not be located. `ambiguous` means it occurs more than once;
 * the fix is a longer quote, not a guess at which occurrence was meant.
 */
export type QuoteRefusal = { kind: "blank" | "too-long" | "missing" | "ambiguous" };

/**
 * Why a quote was refused, finishing "the quote …" and saying what would fix
 * it: its reader is often a model, which can correct what it is told.
 */
export const QUOTE_REFUSALS: Record<QuoteRefusal["kind"], string> = {
  blank: "is blank",
  "too-long": "is longer than 2000 characters; cite a passage, not a chapter",
  missing: "does not occur in the source",
  ambiguous: "occurs more than once in the source; quote more of it",
};

/**
 * A passage, not a chapter: long enough for a paragraph, short enough that a
 * content owner reviewing it reads what was cited.
 */
const MAX_QUOTE_LENGTH = 2000;

/**
 * Finds the one place a quote occurs in a source's text. This is what makes
 * grounding a check rather than a promise: a proposer — Braivo's AI or a
 * content owner's own agent — says which words it relied on, and a quote that
 * is not in the source is refused, whoever wrote it.
 *
 * Whitespace is matched loosely: any run of it in the quote matches any run of
 * it in the text, since models and copy-paste both reflow lines. Everything
 * else is exact, after the same NFC normalization the source's text was given.
 * A quote occurring twice is refused, so a citation always means one passage.
 */
export function locateQuote(text: string, quote: string): QuoteLocation | QuoteRefusal {
  if (quote.length > MAX_QUOTE_LENGTH) return { kind: "too-long" };
  // An unpaired surrogate cannot occur in a stored source, so it cannot match.
  if (!quote.isWellFormed()) return { kind: "missing" };

  const words = quote
    .normalize("NFC")
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return { kind: "blank" };

  const pattern = new RegExp(words.map((word) => RegExp.escape(word)).join("\\s+"), "gu");
  const first = pattern.exec(text);
  if (first === null) return { kind: "missing" };

  // One code point past the first match's start rather than past its end, so
  // an overlapping second occurrence — "la la" in "la la la" — is found too. A
  // code point, not a UTF-16 unit: landing inside a surrogate pair, a `u` regex
  // backs up to the pair's start and finds the first match again.
  pattern.lastIndex = first.index + (first[0].codePointAt(0)! > 0xffff ? 2 : 1);
  if (pattern.exec(text) !== null) return { kind: "ambiguous" };

  const start = countCodePoints(text, 0, first.index);
  return { kind: "located", start, end: start + countCodePoints(first[0], 0, first[0].length) };
}

/** Code points in `text` between two UTF-16 positions, without copying it. */
function countCodePoints(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index++) {
    const unit = text.charCodeAt(index);
    // A high surrogate followed by a low one is a single code point.
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < to) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}
