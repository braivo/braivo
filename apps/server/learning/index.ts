// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Turns learner evidence into knowledge estimates, and estimates into the next
// objective and learning intent or into a report of where a learner stands.
// Pure and subject-neutral: `now` and the model are arguments, and a
// conjugation, a derivative, and a balanced equation all pass through in the
// same form. See docs/specs/learning-model.md.
//
// `replay` is the only way from evidence to estimates. The single-record fold
// beneath it, `updateEstimate`, stays inside the module: an estimate does not
// record which evidence it last absorbed, so two records with the same
// timestamp folded by hand could be applied in an order replay would not use,
// and nothing could tell.

export type { KnowledgeReport, ObjectiveStanding } from "./assess.ts";
export { assessKnowledge } from "./assess.ts";
export type { Evidence, KnowledgeEstimate } from "./estimate.ts";
export { replay } from "./estimate.ts";
export type { LearningModel } from "./model.ts";
export { activeModel } from "./model.ts";
export type { LearningDecision } from "./select.ts";
export { selectNext } from "./select.ts";
