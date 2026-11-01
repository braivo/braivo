// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import type { Evidence } from "../learning/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
import { lastPractised } from "./last-practised.ts";

const asOf = new Date("2026-06-10T12:00:00Z");
const objectiveIds = new Set(["greetings", "numbers"]);
const at = (iso: string) => new Date(iso);

function attempt(
  id: string,
  objectiveId: string,
  when: Date,
  outcome: Evidence["outcome"] = "success",
): Evidence {
  return { id: `${ATTEMPT_EVIDENCE_PREFIX}${id}:${objectiveId}`, objectiveId, outcome, at: when };
}

describe("lastPractised", () => {
  test("is the latest attempt answered here on the course's objectives", () => {
    expect(
      lastPractised(
        [
          attempt("1", "greetings", at("2026-06-08T09:00:00Z")),
          // Show answer is recorded as a failed attempt: practice too.
          attempt("2", "numbers", at("2026-06-09T09:00:00Z"), "failure"),
          // The same day, later.
          attempt("3", "greetings", at("2026-06-09T18:00:00Z")),
        ],
        objectiveIds,
        asOf,
      ),
    ).toEqual(at("2026-06-09T18:00:00Z"));
  });

  test("ignores a result recorded elsewhere, even the latest", () => {
    const outside: Evidence = {
      id: "lms:quiz-7",
      objectiveId: "greetings",
      outcome: "success",
      at: at("2026-06-10T08:00:00Z"),
    };
    expect(lastPractised([outside], objectiveIds, asOf)).toBeUndefined();
    expect(
      lastPractised(
        [attempt("1", "greetings", at("2026-06-01T09:00:00Z")), outside],
        objectiveIds,
        asOf,
      ),
    ).toEqual(at("2026-06-01T09:00:00Z"));
  });

  test("counts an objective the course shares, and no other", () => {
    // Attempts carry no course: one made in another course on a shared objective counts.
    expect(
      lastPractised([attempt("1", "weather", at("2026-06-09T09:00:00Z"))], objectiveIds, asOf),
    ).toBeUndefined();
    expect(
      lastPractised([attempt("1", "numbers", at("2026-06-09T09:00:00Z"))], objectiveIds, asOf),
    ).toEqual(at("2026-06-09T09:00:00Z"));
  });

  test("ignores an attempt after the moment described (progress-6)", () => {
    expect(
      lastPractised([attempt("1", "greetings", at("2026-06-10T12:00:01Z"))], objectiveIds, asOf),
    ).toBeUndefined();
    expect(lastPractised([attempt("1", "greetings", asOf)], objectiveIds, asOf)).toEqual(asOf);
  });
});
