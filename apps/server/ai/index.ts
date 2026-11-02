// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Model calls, prompts, and validation of what models answer. A model proposes
// and Braivo checks: nothing here stores anything or trusts an answer it has not
// checked against `content`'s rules (docs/adr/0029-server-drafting.md).

export type { Draft, DraftCounts, DraftQuote, DraftRefusalCode } from "./draft.ts";
export { DRAFT_OPERATION, draftCourse } from "./draft.ts";
export type { ReadingCounts } from "./extract.ts";
export { extractPages, READ_OPERATION } from "./extract.ts";
export type { Model, ModelFailureCode, ModelFile } from "./model.ts";
export { anthropicModel, ModelUnavailable } from "./model.ts";
export type { Operation } from "./operation.ts";
export { promptVersion } from "./operation.ts";
