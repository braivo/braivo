// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Model calls, prompts, and validation of what models answer. A model proposes
// and Braivo checks: nothing here stores anything or trusts an answer it has not
// checked against `content`'s rules (docs/adr/0029-server-drafting.md).

export type { Draft, DraftQuote } from "./draft.ts";
export { draftCourse } from "./draft.ts";
export { extractPages } from "./extract.ts";
export type { Model, ModelFile } from "./model.ts";
export { anthropicModel, ModelUnavailable } from "./model.ts";
