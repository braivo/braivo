// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { locateQuote, QUOTE_REFUSALS } from "../content/index.ts";
import {
  type Citation,
  type CitedPassage,
  createCitations,
  findObjectivesOutsideOrganization,
  readObjectiveCitations,
  readSourceTexts,
} from "../persistence/index.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/** What a caller asks to cite: an objective, a source, and the words relied on. */
export type QuotedCitation = { objectiveId: string; sourceId: string; quote: string };

/**
 * A quote that cannot be cited, naming which one and why, so a proposer — often
 * a model — can correct it rather than guess. Nothing in the batch was stored.
 */
export class InvalidCitation extends Error {
  /** `where` names the citation in the caller's batch: "Citation 3", "Task 1, citation 0". */
  constructor(where: string, reason: string) {
    super(`${where}: the quote ${reason}.`);
    this.name = "InvalidCitation";
  }
}

/**
 * Locates quotes in an organization's sources, in the order given: the one
 * grounding check every kind of citation passes through (ADR 0021). Throws
 * `NotPermitted` for a source that is not the organization's, and
 * `InvalidCitation`, named by `where`, for a quote that cannot be cited.
 */
export async function locateCitations(
  database: Database,
  organizationId: string,
  quotes: readonly { sourceId: string; quote: string; where: string }[],
): Promise<{ sourceId: string; start: number; end: number }[]> {
  const texts = await readSourceTexts(
    database,
    organizationId,
    quotes.map((quoted) => quoted.sourceId),
  );

  return quotes.map(({ sourceId, quote, where }) => {
    const text = texts.get(sourceId);
    // Named as a foreign objective's refusal is, and for the same reason: a
    // source another organization owns and one that does not exist are one answer.
    if (text === undefined) {
      throw new NotPermitted(`Organization "${organizationId}" does not own "${sourceId}".`);
    }

    const location = locateQuote(text, quote);
    if (location.kind !== "located")
      throw new InvalidCitation(where, QUOTE_REFUSALS[location.kind]);

    return { sourceId, start: location.start, end: location.end };
  });
}

/**
 * Links objectives to the passages of sources that teach them, and returns
 * where each quote was found. All or nothing: one quote that is not in its
 * source refuses the batch, since a partly stored batch is one a retrying
 * caller cannot reason about.
 *
 * This is how derived content stays answerable to its source (ADR 0021). A new
 * objective is defined first and cited here; an existing one cited from a
 * second source is the same objective, not a duplicate.
 */
export async function citeSources(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must administer the organization. */
  actingAs: string;
  citations: readonly QuotedCitation[];
}): Promise<Citation[]> {
  const { database, organizationId, actingAs, citations } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const outside = await findObjectivesOutsideOrganization(
    database,
    organizationId,
    citations.map((citation) => citation.objectiveId),
  );
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  const passages = await locateCitations(
    database,
    organizationId,
    citations.map(({ sourceId, quote }, index) => ({
      sourceId,
      quote,
      where: `Citation ${index}`,
    })),
  );
  const located = passages.map((passage, index) => ({
    objectiveId: citations[index]!.objectiveId,
    ...passage,
  }));

  await createCitations(database, organizationId, located);
  return located;
}

/**
 * The passages an organization's objective cites, or `undefined` when the
 * organization has no such objective.
 */
export async function listObjectiveCitations(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  objectiveId: string;
}): Promise<CitedPassage[] | undefined> {
  const { database, organizationId, actingAs, objectiveId } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const [outside] = await findObjectivesOutsideOrganization(database, organizationId, [
    objectiveId,
  ]);
  if (outside !== undefined) return undefined;

  return readObjectiveCitations(database, objectiveId);
}
