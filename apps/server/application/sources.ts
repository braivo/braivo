// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type Cue,
  joinCues,
  joinPages,
  normalizeSourceText,
  type Page,
  type Pagination,
  parseLanguageTag,
  isStorableText,
  MAX_TITLE,
  parseSourceUrl,
  type Timing,
} from "../content/index.ts";
import {
  createSource,
  readFile,
  readSource,
  readSources,
  type Source,
  type SourceSummary,
} from "../persistence/index.ts";
import { FILE_ID } from "./files.ts";
import { assertMayAdminister } from "./permission.ts";

/** A source that cannot be stored as sent; the message says what would fix it. Nothing was stored. */
export class InvalidSource extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSource";
  }
}

/**
 * Adds material a content owner provides, as text, and returns its ID; the same
 * source added again returns the existing one (docs/adr/0024-idempotent-authoring.md).
 *
 * Whoever extracted the text — Braivo, or the content owner's own tools working
 * on a PDF or a recording — calls this the same way, which is what lets that
 * work happen outside Braivo. See docs/adr/0020-source-content.md.
 */
export async function addSource(
  input: {
    database: Database;
    organizationId: string;
    /** The signed-in actor, who must administer the organization. */
    actingAs: string;
    title: string;
    /** The link the text came from — a YouTube video, a web article — when there is one. */
    url?: string;
    /** The text's main language, as a BCP 47 tag. */
    language?: string;
    /**
     * The file the text was extracted from, by the ID uploading it answered:
     * kept with the source, and part of what it is (docs/adr/0028-original-files.md).
     */
    original?: string;
    now: Date;
  } & (
    | { text: string; cues?: undefined; pages?: undefined }
    /**
     * A recording's captions instead of text: Braivo joins them into the text
     * and keeps when each is said, so a passage cited from it names its moment
     * (docs/adr/0025-timed-transcripts.md).
     */
    | { cues: readonly Cue[]; text?: undefined; pages?: undefined }
    /**
     * A document's pages instead of text: Braivo joins them into the text and
     * keeps where each begins, so a passage cited from it names its page
     * (docs/adr/0026-paged-documents.md).
     */
    | { pages: readonly Page[]; text?: undefined; cues?: undefined }
  ),
): Promise<string> {
  const { database, organizationId, actingAs, now } = input;

  // Checked first, since it depends only on what was sent. Each message says
  // what would fix it, for a model adding sources as much as for a person; none
  // echoes the title or text, which may be as long as the request allows.
  if (!isStorableText(input.title, MAX_TITLE)) {
    throw new InvalidSource(
      `The source's title is blank, over ${MAX_TITLE} characters, or carries a NUL or an unpaired surrogate, which Braivo cannot store as text.`,
    );
  }
  const title = input.title.trim();
  let text: string | undefined;
  let located: { timing: Timing } | { pagination: Pagination } | undefined;
  if (input.cues !== undefined) {
    const joined = joinCues(input.cues);
    if ("problem" in joined) throw new InvalidSource(`${joined.problem}.`);
    text = joined.text;
    located = { timing: joined.timing };
  } else if (input.pages !== undefined) {
    const joined = joinPages(input.pages);
    if ("problem" in joined) throw new InvalidSource(`${joined.problem}.`);
    text = joined.text;
    located = { pagination: joined.pagination };
  } else {
    text = normalizeSourceText(input.text);
    if (text === undefined) {
      throw new InvalidSource(
        "The source's text is blank, or carries a NUL or an unpaired surrogate, which Braivo cannot store as text.",
      );
    }
  }
  const url = input.url === undefined ? undefined : parseSourceUrl(input.url);
  if (input.url !== undefined && url === undefined) {
    throw new InvalidSource(
      "The source's url must be an http or https link, without a user name or password, of at most 2048 characters.",
    );
  }
  const language = input.language === undefined ? undefined : parseLanguageTag(input.language);
  if (input.language !== undefined && language === undefined) {
    throw new InvalidSource(
      "The source's language must be a BCP 47 tag such as es or en-US, not a language's name.",
    );
  }

  const { original } = input;
  if (original !== undefined && !FILE_ID.test(original)) {
    throw new InvalidSource(
      "The source's original must be a file's ID: the lowercase SHA-256 uploading it answered with.",
    );
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  // Checked after permission, so a stranger learns nothing of the organization's files.
  if (original !== undefined && !(await readFile(database, organizationId, original))) {
    throw new InvalidSource(
      "The source's original is not a file of this organization's; upload it first.",
    );
  }

  return createSource(database, {
    organizationId,
    title,
    text,
    url,
    language,
    original,
    ...located,
    createdAt: now,
  });
}

/** Every source an organization has, by title and without their text. */
export async function listSources(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<SourceSummary[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readSources(database, organizationId);
}

/** One of an organization's sources, text included, or `undefined` when it has no such source. */
export async function getSource(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  sourceId: string;
}): Promise<Source | undefined> {
  const { database, organizationId, actingAs, sourceId } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readSource(database, organizationId, sourceId);
}
