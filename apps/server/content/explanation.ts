// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so the browser client shares it (`api/client.ts`): the
// console's counts and the course listing's `counts` use one definition.

/**
 * Whether a task explains its answer after grading. A stored body has a
 * nonblank one or none (`parseTaskBody` refuses a blank one), so absent is the
 * only "missing". `persistence/task.ts` says the same in SQL
 * (`body->>'explanation' IS NULL`).
 */
export const hasExplanation = (body: { explanation?: string }): boolean =>
  body.explanation !== undefined;

/**
 * How many of a course's or an objective's unretired tasks have no
 * explanation, published and pending apart, and of the published, how many
 * also cite no passage: the course listing's `counts`, and the console's.
 */
export type ExplanationCounts = {
  published: { total: number; withoutExplanation: number; withoutExplanationOrPassage: number };
  pending: { total: number; withoutExplanation: number };
};
