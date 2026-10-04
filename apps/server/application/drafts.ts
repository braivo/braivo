// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { type Draft, draftCourse } from "../ai/index.ts";
import { readSource } from "../persistence/index.ts";
import { type Ai, InvalidAiRequest, modelFor } from "./ai.ts";

/**
 * A few textbook chapters: what one draft can cover well and one answer can
 * hold. More is several sources, each drafted on its own.
 */
const MAX_CHARACTERS = 200_000;

/** Long enough to describe a class — "grade 2, English speakers learning Spanish". */
const MAX_AUDIENCE = 200;

/**
 * Drafts a course from one of an organization's sources with the
 * installation's own model, for whoever administers it, or `undefined` when it
 * has no such source. The draft is checked and returned, never stored: review
 * happens where it is shown, and accepting it is authoring through the usual
 * endpoints (docs/adr/0029-server-drafting.md).
 */
export async function draftFromSource(input: {
  database: Database;
  /** For the source itself, which never changes; access is checked fresh. */
  cachedDatabase: Database;
  ai: Ai | undefined;
  organizationId: string;
  actingAs: string;
  sourceId: string;
  /** Who the course is for, in the content owner's words. */
  audience?: string;
  now: Date;
  /** The request's: the model is not kept answering someone who left. */
  signal?: AbortSignal;
}): Promise<Draft | undefined> {
  const { database, cachedDatabase, ai, organizationId, actingAs, sourceId } = input;

  const audience = input.audience?.trim() || undefined;
  if (audience !== undefined && (audience.length > MAX_AUDIENCE || audience.includes("\u0000"))) {
    throw new InvalidAiRequest(
      `Describe the learners in at most ${MAX_AUDIENCE} characters, such as "grade 2, English speakers".`,
    );
  }

  const { model, charge } = await modelFor(database, ai, { organizationId, actingAs });

  const source = await readSource(cachedDatabase, organizationId, sourceId);
  if (!source) return undefined;
  if (source.text.length > MAX_CHARACTERS) {
    throw new InvalidAiRequest(
      `The source is longer than ${MAX_CHARACTERS.toLocaleString("en")} characters; add it as several sources, a chapter each, and draft from each.`,
    );
  }

  await charge("draft", input.now);
  return draftCourse(model, source, { audience, signal: input.signal });
}
