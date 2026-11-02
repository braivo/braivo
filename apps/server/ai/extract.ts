// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import * as z from "zod";

import { joinPages, type Page } from "../content/index.ts";
import { type Model, type ModelFile, ModelUnavailable } from "./model.ts";
import { answer, type Operation } from "./operation.ts";

/** What the model is asked to answer, and the only shape Braivo reads from it. */
const Answer = z.object({
  pages: z
    .array(
      z.object({
        page: z.string().describe("The page's number as printed on it, or its place from 1."),
        text: z.string().describe("Everything the page says, as it reads."),
      }),
    )
    .describe("In reading order, leaving out pages without words."),
});

const SYSTEM = `You transcribe a teacher's material — a textbook, a worksheet, slides, a photo of a page — so it can be taught from and quoted.

Transcribe each page's words exactly as printed, in their language, in reading order: headings, paragraphs, exercises, captions, and the words in tables and pictures, one line each. Keep spelling, accents, and punctuation as they are; correct nothing and add nothing. Leave out running headers, footers, and page numbers.

Label each page with the number printed on it — 12, iv — or, where none is printed, its place in the file from 1. Leave out pages without words.`;

/** What reading a file tells the model; the file is all a request adds. */
export const READ_OPERATION = {
  system: SYSTEM,
  template: "Transcribe this material, page by page.",
  parts: {},
  tool: { name: "transcribe", description: "Gives the material's text, page by page." },
  schema: Answer,
} satisfies Operation;

/**
 * How a reading went, for the ledger: the pages kept, and the blank entries
 * the model returned anyway and Braivo dropped. A blank page it left out, as
 * asked, is not knowable from its answer.
 */
export type ReadingCounts = { pages: number; blankEntries: number };

/**
 * A document's or a photo's text, page by page, transcribed by `model`
 * (docs/adr/0030-server-extraction.md): what a content owner who cannot
 * extract it themselves sends as a paged source. Checked as a source's pages
 * are, so what comes back can be added as it is.
 */
export async function extractPages(
  model: Model,
  file: ModelFile,
  signal?: AbortSignal,
): Promise<{ pages: Page[]; counts: ReadingCounts }> {
  const answered = await answer(model, READ_OPERATION, { files: [file], signal });
  const parsed = Answer.safeParse(answered);
  if (!parsed.success)
    throw new ModelUnavailable("wrong-shape", "The model answered without the shape asked for.");

  const pages = parsed.data.pages.filter(({ text }) => text.trim() !== "");
  if (pages.length === 0) {
    throw new ModelUnavailable("no-words", "The model found no words to transcribe.");
  }
  const joined = joinPages(pages);
  if ("problem" in joined) {
    throw new ModelUnavailable(
      "invalid-output",
      `The model's transcription cannot be a source: ${joined.problem}.`,
    );
  }
  return {
    pages,
    counts: { pages: pages.length, blankEntries: parsed.data.pages.length - pages.length },
  };
}
