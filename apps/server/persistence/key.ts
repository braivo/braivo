// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A key the organization already uses for something else: an objective under
 * another title, a course over other objectives. Like `ConflictingEvidence`, a
 * mistake to surface rather than a retry to absorb — the first stands, and a
 * retry of it would have matched (docs/adr/0024-idempotent-authoring.md).
 *
 * `what` names the item in the caller's request, "Objective 2" or "The course",
 * so the message can say which one to fix.
 */
export class ConflictingKey extends Error {
  constructor(what: string, key: string, other: string) {
    super(
      `${what} has key "${key}", which already names ${other}; use another key, or send exactly what it names.`,
    );
    this.name = "ConflictingKey";
  }
}
