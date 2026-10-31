// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { PRACTICE_RECENCIES, type PracticeRecency } from "./practice-window.ts";

/**
 * A course's progress page as someone left it, kept in its URL so a learner's
 * report leads back to it: where it was opened from, the learner searched
 * for, the order, and the practice filter. Only these values: a URL grants
 * nothing, and leads nowhere but these pages.
 */
export type ProgressSearch = {
  /** Opened from the Groups page, its way back; otherwise the course's or, to someone not administering, Groups. */
  from?: "groups";
  /** "Find a learner", as typed. */
  q?: string;
  /** Most learning, most due for review, or most repeated misses first; by name otherwise. */
  sort?: ProgressSort;
  /** Only the learners who practised in the last seven days, before, or never (progress-17). */
  practice?: PracticeRecency;
};

export const PROGRESS_SORTS = ["learning", "due", "misses"] as const;
type ProgressSort = (typeof PROGRESS_SORTS)[number];

/** The longest "Find a learner" the URL keeps. */
export const MAX_QUERY = 200;

export function validateProgressSearch(search: Record<string, unknown>): ProgressSearch {
  return {
    ...(search.from === "groups" && { from: "groups" as const }),
    ...(typeof search.q === "string" && search.q !== "" && { q: search.q.slice(0, MAX_QUERY) }),
    ...(PROGRESS_SORTS.includes(search.sort as ProgressSort) && {
      sort: search.sort as ProgressSort,
    }),
    ...(PRACTICE_RECENCIES.includes(search.practice as PracticeRecency) && {
      practice: search.practice as PracticeRecency,
    }),
  };
}
