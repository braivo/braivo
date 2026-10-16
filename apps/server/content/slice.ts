// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { codePoints, partAt } from "./locator.ts";
import type { Pagination } from "./pages.ts";
import type { Timing } from "./transcript.ts";

/**
 * Part of a source to read, as `A-B` or `A-` (to the end): pages by position
 * from 1, both ends included; seconds of a recording, or characters (code
 * points) of the text, from A up to B. One of them. Pages by position, not
 * label, since labels need not be unique or ordered (sources-8).
 */
export type SourceRange = { pages?: string; seconds?: string; characters?: string };

/**
 * A bounded read of a source's text: `text` is the code points `start` to
 * `end` of `length`, with the timing or pagination entries it overlaps, in
 * the whole text's positions, so a cited range reads the same as in a full
 * read. `next`, when what was asked runs past `end`, is the range to ask next.
 */
export type SourceSlice = {
  text: string;
  start: number;
  end: number;
  length: number;
  timing?: Timing;
  pagination?: Pagination;
  next?: { characters: string };
};

/**
 * The most text one read answers, in code points: what the console shows of a
 * source before "show all" (sources-20), some ten pages of a textbook. Not a
 * token count: a code point of some scripts takes more than one token. Small
 * enough for app directories, which refuse a tool answering a whole dataset.
 */
export const MAX_SLICE_CODE_POINTS = 20_000;

/**
 * The most pages or cues one read answers, each some 30 bytes of JSON: so
 * short cues, a few characters each, add at most about `MAX_SLICE_CODE_POINTS` to it.
 */
const MAX_SLICE_PARTS = 500;

const RANGE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)?$/;
const WHOLE = /^\d+$/;

/**
 * The part of `source` that `range` asks for, cut to at most `MAX_SLICE_CODE_POINTS`
 * code points and `MAX_SLICE_PARTS` pages or cues at the last page or cue that
 * starts within it, else the last line break, else anywhere; or what is wrong
 * with the range, saying what would fix it.
 */
export function sliceSource(
  source: { text: string; timing?: Timing; pagination?: Pagination },
  range: SourceRange,
): SourceSlice | { problem: string } {
  const asked = Object.entries(range).filter(([, value]) => value !== undefined);
  if (asked.length !== 1) {
    return { problem: "Ask for one of pages, seconds, or characters, such as pages=1-5." };
  }
  const [unit, value] = asked[0] as [keyof SourceRange, string];

  const match = RANGE.exec(value);
  if (!match || (unit !== "seconds" && !(WHOLE.test(match[1]!) && WHOLE.test(match[2] ?? "0")))) {
    return {
      problem: `${unit} must be a range such as 12-16, or 12- to read on from 12${unit === "seconds" ? "" : ", in whole numbers"}.`,
    };
  }
  const from = Number(match[1]);
  const to = match[2] === undefined ? undefined : Number(match[2]);
  if (to !== undefined && (unit === "pages" ? to < from : to <= from)) {
    return { problem: `The range ${value} ends before it starts.` };
  }

  const length = codePoints(source.text);
  const parts = source.pagination ?? source.timing ?? [];
  let start: number;
  let end: number;

  if (unit === "pages") {
    const { pagination } = source;
    if (!pagination) {
      return { problem: "This source has no pages: read it by characters." };
    }
    if (from < 1 || from > pagination.length) {
      return {
        problem: `This source has ${pagination.length} pages: ask for pages 1 to ${pagination.length}.`,
      };
    }
    start = pagination[from - 1]!.start;
    end = to === undefined || to >= pagination.length ? length : pagination[to]!.start;
  } else if (unit === "seconds") {
    const { timing } = source;
    if (!timing) {
      return { problem: "This source has no timing: read it by characters." };
    }
    const last = timing.at(-1)!;
    if (from > last.at) {
      return {
        problem: `This recording's last cue starts at second ${last.at}: ask for seconds before it.`,
      };
    }
    // From the cue being said at `from`, so a range never starts mid-sentence
    // and always holds at least that cue.
    const first = timing.findLastIndex((cue) => cue.at <= from);
    const firstIndex = Math.max(first, 0);
    start = timing[firstIndex]!.start;
    const after =
      to === undefined
        ? undefined
        : timing.find((cue, index) => index > firstIndex && cue.at >= to);
    end = after?.start ?? length;
  } else {
    if (from >= length) {
      return { problem: `This source has ${length} characters: start before ${length}.` };
    }
    start = from;
    end = to === undefined ? length : Math.min(to, length);
  }

  // The part `start` falls in is the first of those the slice holds.
  const first = Math.max(
    parts.findLastIndex((part) => part.start <= start),
    0,
  );
  const limit = Math.min(
    start + MAX_SLICE_CODE_POINTS,
    parts[first + MAX_SLICE_PARTS]?.start ?? Infinity,
  );
  const cut = end > limit ? cutAt(source.text, parts, start, limit) : end;
  return {
    text: codePointSlice(source.text, start, cut),
    start,
    end: cut,
    length,
    ...(source.timing && { timing: overlapping(source.timing, start, cut) }),
    ...(source.pagination && { pagination: overlapping(source.pagination, start, cut) }),
    ...(cut < end && { next: { characters: `${cut}-${end}` } }),
  };
}

/**
 * Where a slice from `start` capped at `limit` ends: the last page or cue
 * starting after `start` and at most at `limit`, so whole parts are read;
 * else just past the last line break; else `limit` itself.
 */
function cutAt(
  text: string,
  parts: readonly { start: number }[],
  start: number,
  limit: number,
): number {
  const part = partAt(parts, limit);
  if (part && part.start > start) return part.start;

  const window = codePointSlice(text, start, limit);
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= 0) return start + codePoints(window.slice(0, lineBreak + 1));
  return limit;
}

/** The entries of `parts` whose part overlaps `start` to `end`. */
function overlapping<Part extends { start: number }>(
  parts: readonly Part[],
  start: number,
  end: number,
): Part[] {
  return parts.filter(
    (part, index) => part.start < end && (parts[index + 1]?.start ?? Infinity) > start,
  );
}

/** `text` from code point `start` up to `end`, never splitting a surrogate pair. */
function codePointSlice(text: string, start: number, end: number): string {
  let position = 0;
  let index = 0;
  let from = text.length;
  for (const character of text) {
    if (position === start) from = index;
    if (position === end) return text.slice(from, index);
    index += character.length;
    position += 1;
  }
  return text.slice(from);
}
