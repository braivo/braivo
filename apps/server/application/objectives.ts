// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { isKey, isStorableText, KEY_RULE, MAX_TITLE } from "../content/index.ts";
import { createObjectives, type Objective, readObjectives } from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/**
 * An objective or a course Braivo will not store, named by where it was sent
 * ("Objective 1", "The course") with what would fix it: the caller is often a
 * model, which can correct a mistake it is told about (ADR 0021).
 */
export class InvalidDefinition extends Error {
  constructor(subject: string, problem: string) {
    super(`${subject} ${problem}.`);
    this.name = "InvalidDefinition";
  }
}

/**
 * Checks an objective's or a course's title and key, answering the title
 * trimmed. An unrecognisable title is refused, since the ID is opaque by
 * design. The refusal never echoes what was sent, which may be long.
 */
export function checkNames(
  subject: string,
  { title, key }: { title: string; key?: string },
): string {
  if (!isStorableText(title, MAX_TITLE)) {
    throw new InvalidDefinition(
      subject,
      `has a title that is blank, over ${MAX_TITLE} characters, or carries a NUL or an unpaired surrogate, which Braivo cannot store as text`,
    );
  }
  if (key !== undefined && !isKey(key)) {
    throw new InvalidDefinition(subject, `has a key that cannot be one: ${KEY_RULE}`);
  }
  return title.trim();
}

/**
 * Registers learning targets for an organization, returning their IDs in the
 * order given. A content owner or their agent names them, including when
 * accepting an AI draft.
 *
 * IDs are generated rather than chosen, so two organizations can both teach the
 * past tense. A `key` is the caller's own name for one, unique within the
 * organization: adding it again returns it, so a retry adds nothing
 * (docs/adr/0024-idempotent-authoring.md).
 */
export async function defineObjectives(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  objectives: readonly { title: string; key?: string }[];
}): Promise<string[]> {
  const { database, organizationId, actingAs, objectives } = input;

  // Checked first, since it depends only on what was sent.
  const checked = objectives.map((objective, index) => ({
    ...objective,
    title: checkNames(`Objective ${index}`, objective),
  }));

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return createObjectives(database, organizationId, checked);
}

/**
 * Every objective an organization has defined, by title: a listing order, not
 * content order, which belongs to a course.
 */
export async function listObjectives(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<Objective[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readObjectives(database, organizationId);
}
