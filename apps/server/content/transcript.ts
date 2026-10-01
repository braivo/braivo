// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { codePoints, partAt } from "./locator.ts";
import { normalizeSourceText } from "./source.ts";

/** One caption of a recording: what is said, from `at` seconds in. */
export type Cue = { at: number; text: string };

/**
 * Where each cue begins in a transcript's text, in code points, and at which
 * second of the recording: what lets a passage cited from the text name the
 * moment it is said (docs/adr/0025-timed-transcripts.md). Ordered by `start`.
 */
export type Timing = { start: number; at: number }[];

/** More cues than a day of speech has; a bound so a request cannot be all cues. */
const MAX_CUES = 100_000;

/** A day, in seconds: longer than any recording a lesson is taken from. */
const MAX_SECONDS = 86_400;

/**
 * A recording's cues as a source's text — each cue's words on a line of its
 * own — and the timing that maps the text back to the recording, or what is
 * wrong with them. Each cue's text is put in the form `normalizeSourceText`
 * gives a source and trimmed, so positions in the joined text are final.
 *
 * `problem` names the cue and says what would fix it, as authoring refusals do
 * (docs/adr/0021-citations.md), and never repeats what was sent.
 */
export function joinCues(
  cues: readonly Cue[],
): { text: string; timing: Timing } | { problem: string } {
  if (cues.length === 0 || cues.length > MAX_CUES) {
    return { problem: `A transcript needs 1 to ${MAX_CUES} cues` };
  }

  const lines: string[] = [];
  const timing: Timing = [];
  let start = 0;
  let previous = 0;
  for (const [index, cue] of cues.entries()) {
    if (!Number.isFinite(cue.at) || cue.at < 0 || cue.at > MAX_SECONDS) {
      return { problem: `Cue ${index} needs \`at\`: seconds from 0 to ${MAX_SECONDS}` };
    }
    if (cue.at < previous) {
      return { problem: `Cue ${index} starts before the cue before it; send cues in order` };
    }
    const text = normalizeSourceText(cue.text)?.trim();
    if (text === undefined || text === "") {
      return {
        problem: `Cue ${index} has no text Braivo can store: it is blank, or carries a NUL or an unpaired surrogate`,
      };
    }

    lines.push(text);
    timing.push({ start, at: cue.at });
    // Code points, as citations count them, plus the line break that follows.
    start += codePoints(text) + 1;
    previous = cue.at;
  }

  return { text: lines.join("\n"), timing };
}

/**
 * The second of the recording at which `position` of its transcript is said:
 * the start of the cue it falls in. Undefined before the first cue, which a
 * transcript built by `joinCues` never has.
 */
export function momentOf(timing: Timing, position: number): number | undefined {
  return partAt(timing, position)?.at;
}
