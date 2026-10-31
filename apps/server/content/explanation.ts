// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so the browser client shares it (`api/client.ts`): the
// console's counts and the course listing's `counts` are one definition, which
// `application/course-tasks.test.ts` pins the listing's SQL to.

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

/** `tasks`, a course's or an objective's unretired ones, counted. */
export function countExplanations(
  tasks: readonly { published: boolean; citations: readonly unknown[]; explanation?: string }[],
): ExplanationCounts {
  const published = tasks.filter((task) => task.published);
  const pending = tasks.filter((task) => !task.published);
  const without = published.filter((task) => !hasExplanation(task));
  return {
    published: {
      total: published.length,
      withoutExplanation: without.length,
      withoutExplanationOrPassage: without.filter((task) => task.citations.length === 0).length,
    },
    pending: {
      total: pending.length,
      withoutExplanation: pending.filter((task) => !hasExplanation(task)).length,
    },
  };
}
