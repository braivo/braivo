// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/** A source's, an objective's, or a course's title: a name, not a description. */
export const MAX_TITLE = 500;

/**
 * Whether PostgreSQL stores `text` as sent: well-formed Unicode without NUL.
 * It refuses a NUL, turning a caller's mistake into a 500, and stores an
 * unpaired surrogate as U+FFFD, so two IDs could become one.
 */
export function isStorable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/**
 * Whether `value` is text a person wrote that Braivo can store: not blank,
 * `isStorable`, and at most `max` characters, since every title and question
 * also lands in pages, logs, and a model's prompt. Counted trimmed, as Braivo
 * stores it.
 */
export function isStorableText(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false;
  const { length } = value.trim();
  return length > 0 && length <= max && isStorable(value);
}
