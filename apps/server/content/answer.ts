// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing: the browser client shares it, through `findings.ts`.

/**
 * A typed answer as it is graded: NFC, lowercased (locale-independent, so the
 * same everywhere), trimmed, each whitespace run one space, and typographic
 * apostrophes and quotes as ASCII ones. Nothing else: accents and punctuation
 * count, and a variant without them is one the author lists
 * (docs/adr/0038-typed-answers.md). The console's task editor keeps a copy,
 * `normalizeAnswer`, to refuse repeats before saving: change both.
 */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u02BC]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"');
}

/** Enough variants of one short answer: the most a typed task accepts. */
export const MAX_ACCEPTED = 20;
