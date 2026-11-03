// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "vite-plus/test";

import { countStandings, standingOf } from "./standing.ts";

test("names each phase as a learner is told it, a due review apart from a retained one", () => {
  expect(standingOf({ phase: "unseen" })).toBe("notStarted");
  expect(standingOf({ phase: "acquiring" })).toBe("learning");
  expect(standingOf({ phase: "retaining", due: true })).toBe("dueForReview");
  expect(standingOf({ phase: "retaining", due: false })).toBe("retained");
});

test("counts every standing, those with none as 0", () => {
  expect(
    countStandings([
      { phase: "retaining", due: false },
      { phase: "retaining", due: false },
      { phase: "acquiring" },
    ]),
  ).toEqual({ retained: 2, dueForReview: 0, learning: 1, notStarted: 0 });
  expect(countStandings([])).toEqual({ retained: 0, dueForReview: 0, learning: 0, notStarted: 0 });
});
