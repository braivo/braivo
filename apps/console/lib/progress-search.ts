// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A course's progress page as someone left it, kept in its URL so a learner's
 * report leads back to it: where it was opened from, the learner searched
 * for, and the order. Only these values: a URL grants nothing, and leads
 * nowhere but these pages.
 */
export type ProgressSearch = {
  /** Opened from the Groups page, its way back; otherwise the course's or, to a teacher, Groups. */
  from?: "groups";
  /** "Find a learner", as typed. */
  q?: string;
  /** Most learning, or most due for review, first; by name otherwise. */
  sort?: "learning" | "due";
};

/** The longest "Find a learner" the URL keeps. */
export const MAX_QUERY = 200;

export function validateProgressSearch(search: Record<string, unknown>): ProgressSearch {
  return {
    ...(search.from === "groups" && { from: "groups" as const }),
    ...(typeof search.q === "string" && search.q !== "" && { q: search.q.slice(0, MAX_QUERY) }),
    ...((search.sort === "learning" || search.sort === "due") && { sort: search.sort }),
  };
}
