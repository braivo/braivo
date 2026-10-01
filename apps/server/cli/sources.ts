// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { BraivoClient } from "@braivo/server/client";

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
 * its page (docs/adr/0026-paged-documents.md).
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
  organizationId: string;
  file: string;
  title?: string;
  url?: string;
  language?: string;
  original?: string;
  readStdin: () => Promise<string>;
}): Promise<string> {
  const { client, organizationId, file, url, language } = input;

  const title = input.title ?? (file === "-" ? undefined : basename(file, extname(file)));
  if (title === undefined) throw new Error("Text from standard input needs a --title.");

  const content = file === "-" ? await input.readStdin() : await readFile(file, "utf8");
  const body = sourceBody(file, content);

  // Only once the text is known to be sendable, so a refused one uploads nothing.
  const original =
    input.original === undefined
      ? undefined
      : await uploadOriginal(client, organizationId, input.original);

  return client.addSource({ organizationId, title, url, language, original, ...body });
}

/** What of a source `content` is: captions, pages, or text, by what the file is. */
function sourceBody(
  file: string,
  content: string,
):
  | { text: string }
  | { pages: { page: string; text: string }[] }
  | { cues: { at: number; text: string }[] } {
  const format = file === "-" ? undefined : captionFormat(file);
  if (format !== undefined) {
    const cues = parseCaptions(content, format);
    if (cues instanceof Error) throw new Error(`${file}: ${cues.message}`);
    return { cues };
  }

  const where = file === "-" ? "Standard input" : file;
  const pages = splitPages(content);
  if (pages === undefined) {
    // Refused here, as Braivo would, so an original is never uploaded for it.
    if (content.trim() === "" || content.includes("\u0000") || !content.isWellFormed()) {
      throw new Error(`${where}: no text Braivo can store; it is blank, or not text.`);
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
 * by position from 1 — a PDF's sheets, which a book's printed numbers need not
 * match; an agent that reads those can send them itself. A page without words,
 * a blank or scanned one, is left out and keeps its number.
 */
export function splitPages(content: string): { page: string; text: string }[] | undefined {
  if (!content.includes("\f")) return undefined;
  return content
    .split("\f")
    .map((text, index) => ({ page: String(index + 1), text }))
    .filter(({ text }) => text.trim() !== "");
}
