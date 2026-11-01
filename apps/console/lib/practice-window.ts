// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { calendarDayIn } from "@braivo/server/client";

/** Practised in the window, only before it, or never: every learner is exactly one. */
export const PRACTICE_RECENCIES = ["recent", "earlier", "none"] as const;
export type PracticeRecency = (typeof PRACTICE_RECENCIES)[number];

/** Today and the six calendar dates before it: a week, whichever weekday it starts on. */
const PRACTICE_WINDOW_DAYS = 7;

/**
 * The practice window a progress answer is read against (progress-17): today
 * and the six calendar dates before `asOf`'s, in `timeZone`, the reader's own
 * unless named. The overview's counts, its filter, and each "Last practised"
 * classify through it, so none can disagree with another.
 */
export function practiceWindow(
  asOf: string,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): {
  timeZone: string;
  /** Calendar dates from `at`'s to `asOf`'s: 0 today, 1 yesterday. */
  calendarDaysAgo: (at: string) => number;
  recencyOf: (lastPractisedAt: string | null) => PracticeRecency;
} {
  const dayOf = calendarDayIn(timeZone);
  const asOfDay = Date.parse(dayOf(new Date(asOf)));
  // Each "YYYY-MM-DD" read as UTC midnight, so whole dates apart: no clock change applies.
  const calendarDaysAgo = (at: string) => (asOfDay - Date.parse(dayOf(new Date(at)))) / 86_400_000;
  return {
    timeZone,
    calendarDaysAgo,
    recencyOf: (lastPractisedAt) =>
      lastPractisedAt === null
        ? "none"
        : calendarDaysAgo(lastPractisedAt) < PRACTICE_WINDOW_DAYS
          ? "recent"
          : "earlier",
  };
}
