// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// What timed transcripts and paged documents share: a source's text joined
// from parts, and a list of where each part starts in it, in code points as
// citations count them. Internal to `content`.

export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * The part `position` falls in: the last to start at or before it. Undefined
 * before the first part, which text joined from parts never has.
 */
export function partAt<Part extends { start: number }>(
  parts: readonly Part[],
  position: number,
): Part | undefined {
  let found: Part | undefined;
  for (const part of parts) {
    if (part.start > position) break;
    found = part;
  }
  return found;
}
