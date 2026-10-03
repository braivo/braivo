// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/** A source's, an objective's, or a course's title: a name, not a description. */
export const MAX_TITLE = 500;

/**
 * Whether `value` is text a person wrote that Braivo can store: not blank,
 * well-formed Unicode without NUL — which PostgreSQL refuses, turning a
 * caller's mistake into a 500 — and at most `max` characters, since every
 * title and question also lands in pages, logs, and a model's prompt. Counted
 * trimmed, as Braivo stores it.
 */
export function isStorableText(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false;
  const { length } = value.trim();
  return length > 0 && length <= max && value.isWellFormed() && !value.includes("\u0000");
}
