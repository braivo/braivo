// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A caller's own name for an objective or a course, which makes adding it
 * again return it rather than a twin (docs/adr/0024-idempotent-authoring.md):
 * `es-greetings`, `unidad-1/numbers`.
 *
 * Lowercase letters, digits, and `.`, `_`, `/`, `-`, starting with a letter or
 * digit, at most 128 characters. Lowercase only, so that `Greetings` and
 * `greetings` cannot name two things; a slug, so that a model can make one up
 * from a title and make the same one again when it retries.
 */
const KEY = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

/** Whether `value` can be a key. */
export function isKey(value: string): boolean {
  return KEY.test(value);
}

/** What a key must be, for a refusal to say. */
export const KEY_RULE =
  "a key is 1 to 128 lowercase letters, digits, and . _ / -, starting with a letter or digit";
