// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Structured learning content and the source text it is grounded in: what a
// task asks, what a learner sees of it, how an answer to it is graded, the one
// form a source's text is stored in, and where a cited quote sits in it. Pure,
// like `learning`; storing and choosing belong to `persistence` and
// `application`. See docs/adr/0015-tasks.md, docs/adr/0020-source-content.md,
// and docs/adr/0021-citations.md.

export type { QuoteLocation, QuoteRefusal } from "./citation.ts";
export { locateQuote, QUOTE_REFUSALS } from "./citation.ts";
export { isKey, KEY_RULE } from "./key.ts";
export type { Page, Pagination } from "./pages.ts";
export { joinPages, pageOf } from "./pages.ts";
export { normalizeSourceText, parseLanguageTag, parseSourceUrl, sourceDigest } from "./source.ts";
export { isStorableText, MAX_TITLE } from "./text.ts";
export type { Cue, Timing } from "./transcript.ts";
export { joinCues, momentOf } from "./transcript.ts";
export type { Grade, TaskBody, PresentedTask, TaskResponse } from "./task.ts";
export { gradeResponse, parseTaskBody, parseTaskResponse, presentTask } from "./task.ts";
