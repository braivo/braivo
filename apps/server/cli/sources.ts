// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { BraivoClient } from "@braivo/server/client";

import { joinCues } from "../content/index.ts";
import { captionFormat, parseCaptions } from "./captions.ts";
import { uploadOriginal } from "./originals.ts";

/**
 * Adds a file's text, or standard input's when `file` is `-`, as a source.
 * Text as Braivo takes it: a PDF's is extracted first — by a desktop agent,
 * say — and piped or saved here (docs/adr/0020-source-content.md).
 *
 * A caption file, `.vtt` or `.srt`, is read into cues instead, so the source is
 * a timed transcript and a passage cited from it names the moment of the video
 * it is said at (docs/adr/0025-timed-transcripts.md). Text with form feeds
 * between pages, as `pdftotext` writes it, is sent as pages, so a passage names
 * its page (docs/adr/0026-paged-documents.md). `firstPage`, as typed, is the
 * book's number of the first page, printed or blank: for a chapter extracted
 * alone (`pdftotext -f`), or a book not numbered by its sheets.
 *
 * The organization is named by its slug, the one in the console's address: an
 * ID would take an API call to find.
 *
 * The title defaults to the file's name without its extension, which is what
 * a content owner would have called it; standard input has no name, so needs one.
 *
 * `original` is the file the text was extracted from — the PDF `pdftotext`
 * read — uploaded first and kept with the source (docs/adr/0028-original-files.md);
 * `originals.ts` decides which files may be.
 */
export async function addSourceFromFile(input: {
  client: BraivoClient;
  organizationSlug: string;
  file: string;
  title?: string;
  url?: string;
  language?: string;
  original?: string;
  firstPage?: string;
  readStdin: () => Promise<string>;
}): Promise<string> {
  const { client, file, url, language } = input;

  const title = input.title ?? (file === "-" ? undefined : basename(file, extname(file)));
  if (title === undefined) throw new Error("Text from standard input needs a --title.");
  const firstPage = firstPageOf(input.firstPage);

  const content = file === "-" ? await input.readStdin() : await readFile(file, "utf8");
  const body = sourceBody(file, content, firstPage);
  const organizationId = await organizationIdOf(client, input.organizationSlug);

  // Only once the text is known to be sendable and the organization found, so
  // a refused one uploads nothing.
  const original =
    input.original === undefined
      ? undefined
      : await uploadOriginal(client, organizationId, input.original);

  return client.addSource({ organizationId, title, url, language, original, ...body });
}

/** The ID of the organization `slug` names, among those the signed-in person manages. */
async function organizationIdOf(client: BraivoClient, slug: string): Promise<string> {
  const managed = await client.listOrganizations();
  const organization = managed.find((candidate) => candidate.slug === slug);
  if (organization) return organization.id;

  const yours = managed.map((candidate) => candidate.slug).join(", ") || "none";
  throw new Error(`You manage no organization "${slug}"; yours: ${yours}.`);
}

/** `--first-page` as a number: whole, from 1, at most six digits — more than any book has. */
function firstPageOf(typed: string | undefined): number | undefined {
  if (typed === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(typed)) {
    throw new Error(
      "--first-page takes the first page's number in the book, a whole number from 1 to 999999.",
    );
  }
  return Number(typed);
}

/** What of a source `content` is: captions, pages, or text, by what the file is. */
function sourceBody(
  file: string,
  content: string,
  firstPage: number | undefined,
):
  | { text: string }
  | { pages: { page: string; text: string }[] }
  | { cues: { at: number; text: string }[] } {
  const where = file === "-" ? "Standard input" : file;
  const format = file === "-" ? undefined : captionFormat(file);
  // `--first-page` is refused rather than ignored where there are no pages, so
  // a page number asked for is never silently lost.
  if (format !== undefined) {
    if (firstPage !== undefined) {
      throw new Error(`${file}: --first-page is for pages, not captions.`);
    }
    const cues = parseCaptions(content, format);
    if (cues instanceof Error) throw new Error(`${file}: ${cues.message}`);
    // Braivo's own check, before uploading the original, since it would refuse these.
    const joined = joinCues(cues);
    if ("problem" in joined) throw new Error(`${file}: ${joined.problem}.`);
    return { cues };
  }

  // Before splitting, since a PDF's bytes can have form feeds too; and before
  // uploading the original, since Braivo would refuse this text.
  if (content.includes("\u0000") || !content.isWellFormed()) {
    throw new Error(
      `${where}: not text Braivo can store; for a PDF, extract its text with pdftotext first.`,
    );
  }
  const pages = splitPages(content, firstPage);
  if (pages === undefined) {
    if (content.trim() === "") throw new Error(`${where}: no text Braivo can store; it is blank.`);
    if (firstPage !== undefined) {
      throw new Error(
        `${where}: --first-page needs pages, separated by form feeds as pdftotext writes.`,
      );
    }
    return { text: content };
  }
  if (pages.length === 0) {
    throw new Error(`${where}: no page has text; a scanned PDF needs OCR first.`);
  }
  return { pages };
}

/**
 * A document's pages, when `content` separates them with form feeds as
 * `pdftotext` does, or `undefined` for text that has none. Pages are labelled
 * by position from `firstPage`, so a page without words, a blank or scanned
 * one, is left out and keeps its number. Labels other than numbers, `iv`, are
 * an agent's to send.
 */
export function splitPages(
  content: string,
  firstPage = 1,
): { page: string; text: string }[] | undefined {
  if (!content.includes("\f")) return undefined;
  return content
    .split("\f")
    .map((text, index) => ({ page: String(firstPage + index), text }))
    .filter(({ text }) => text.trim() !== "");
}
