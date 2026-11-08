// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { type Draft, draftCourse } from "../ai/index.ts";
import { isStorableText, parseLanguageTag } from "../content/index.ts";
import { readSource } from "../persistence/index.ts";
import { type Ai, aiFor, InvalidAiRequest } from "./ai.ts";

/**
 * A few textbook chapters: what one draft can cover well and one answer can
 * hold. More is several sources, each drafted on its own.
 */
const MAX_CHARACTERS = 200_000;

/** Long enough to describe a class — "grade 2, English speakers learning Spanish". */
const MAX_AUDIENCE = 200;

/** A sentence or two of what learners should be able to do. */
const MAX_GOAL = 300;

/**
 * Drafts a course from one of an organization's sources with the
 * installation's own model, for whoever may author in it, or `undefined` when it
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
  /** What learners should be able to do, as the request sent it. Absent, nothing guides the draft. */
  goal?: unknown;
  /**
   * The language of titles, prompts, and explanations, as the request sent it.
   * A tag, as a source's language is: of any language, not only those Braivo's
   * apps speak, since a course's language is not the interface's
   * (docs/specs/localization.md, Boundaries), and never a name for the model to
   * interpret. Required: inferred from the learners, it was read as the
   * language they learn (ADR 0029).
   */
  instructionLanguage: unknown;
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

  if (input.goal !== undefined && !isStorableText(input.goal, MAX_GOAL)) {
    throw new InvalidAiRequest(
      `Say in the goal what learners should be able to do, in 1 to ${MAX_GOAL} characters of text.`,
    );
  }
  const goal = input.goal?.trim();

  const instructionLanguage =
    typeof input.instructionLanguage === "string"
      ? parseLanguageTag(input.instructionLanguage)
      : undefined;
  if (instructionLanguage === undefined) {
    throw new InvalidAiRequest(
      "Name the language for learners' instructions as a BCP 47 tag such as es or en-US, not a language's name.",
    );
  }

  const { ask } = await aiFor(database, ai, { organizationId, actingAs });

  const source = await readSource(cachedDatabase, organizationId, sourceId);
  if (!source) return undefined;
  if (source.text.length > MAX_CHARACTERS) {
    throw new InvalidAiRequest(
      `The source is longer than ${MAX_CHARACTERS.toLocaleString("en")} characters; add it as several sources, a chapter each, and draft from each.`,
    );
  }

  return ask({
    kind: "draft",
    now: input.now,
    signal: input.signal,
    work: async (model) => {
      const { draft, counts } = await draftCourse(model, source, {
        goal,
        audience,
        instructionLanguage,
        signal: input.signal,
      });
      return { result: draft, counts };
    },
  });
}
