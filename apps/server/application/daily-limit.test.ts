// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import type { Evidence } from "../learning/index.ts";
import { isTimeZone, NEW_OBJECTIVES_PER_DAY, limitNewObjectives } from "./daily-limit.ts";

const started = Array.from({ length: NEW_OBJECTIVES_PER_DAY }, (_, i) => `started-${i}`);
const unseen = ["unseen-1", "unseen-2"];

/** A learner in a course of `started` then `unseen`, with `evidence`. */
function learnerWith(evidence: Evidence[]) {
  return { objectiveIds: [...started, ...unseen], evidence };
}

/** One record on each of `objectiveIds`, all at `at`. */
const startedAt = (at: string, objectiveIds = started): Evidence[] =>
  objectiveIds.map((objectiveId) => ({
    id: `${objectiveId}@${at}`,
    objectiveId,
    outcome: "success",
    at: new Date(at),
  }));

describe("limitNewObjectives", () => {
  test("leaves every objective in until the day's limit is reached", () => {
    const learner = learnerWith(startedAt("2026-06-01T08:00:00Z", started.slice(1)));
    expect(
      limitNewObjectives(learner, { now: new Date("2026-06-01T09:00:00Z"), timeZone: "UTC" }),
    ).toEqual({ candidates: learner.objectiveIds, heldBack: false });
  });

  test("then holds back the objectives not started yet, and only those", () => {
    const learner = learnerWith(startedAt("2026-06-01T08:00:00Z"));
    expect(
      limitNewObjectives(learner, { now: new Date("2026-06-01T09:00:00Z"), timeZone: "UTC" }),
    ).toEqual({ candidates: started, heldBack: true });
  });

  test("counts an objective once, on the day of its first evidence", () => {
    // Started yesterday, practised again today: none of them started today.
    const learner = learnerWith([
      ...startedAt("2026-05-31T08:00:00Z"),
      ...startedAt("2026-06-01T08:00:00Z"),
      ...startedAt("2026-06-01T08:05:00Z"),
    ]);
    expect(
      limitNewObjectives(learner, { now: new Date("2026-06-01T09:00:00Z"), timeZone: "UTC" })
        .heldBack,
    ).toBe(false);
  });

  test("finds the first evidence whatever order it comes in", () => {
    const learner = learnerWith([
      ...startedAt("2026-06-01T08:00:00Z"),
      ...startedAt("2026-05-31T08:00:00Z"),
    ]);
    expect(
      limitNewObjectives(learner, { now: new Date("2026-06-01T09:00:00Z"), timeZone: "UTC" })
        .heldBack,
    ).toBe(false);
  });

  test("tells today from the same date in another century", () => {
    const learner = learnerWith(startedAt("1926-06-01T08:00:00Z"));
    expect(
      limitNewObjectives(learner, { now: new Date("2026-06-01T09:00:00Z"), timeZone: "UTC" })
        .heldBack,
    ).toBe(false);
  });

  test("counts days in the learner's time zone, from four", () => {
    // 01:00 on June 1 in New York, still May 31's day there; June 1's in UTC.
    const learner = learnerWith(startedAt("2026-06-01T05:00:00Z"));
    // 05:00 on June 1 in New York: a new day there, not in UTC.
    const now = new Date("2026-06-01T09:00:00Z");
    expect(limitNewObjectives(learner, { now, timeZone: "America/New_York" }).heldBack).toBe(false);
    expect(limitNewObjectives(learner, { now, timeZone: "UTC" }).heldBack).toBe(true);
  });

  test("counts a session past midnight as the evening's", () => {
    // 23:30 on May 31 in UTC; then 00:30 on June 1.
    const learner = learnerWith(startedAt("2026-05-31T23:30:00Z"));
    const now = new Date("2026-06-01T00:30:00Z");
    expect(limitNewObjectives(learner, { now, timeZone: "UTC" }).heldBack).toBe(true);
  });

  test("holds nothing back once nothing is left to start", () => {
    const learner = learnerWith(startedAt("2026-06-01T08:00:00Z"));
    const now = new Date("2026-06-01T09:00:00Z");
    expect(
      limitNewObjectives({ ...learner, objectiveIds: started }, { now, timeZone: "UTC" }),
    ).toEqual({ candidates: started, heldBack: false });
  });
});

test("isTimeZone accepts IANA names, and nothing else", () => {
  expect(isTimeZone("Europe/Warsaw")).toBe(true);
  expect(isTimeZone("UTC")).toBe(true);
  expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  expect(isTimeZone("")).toBe(false);
});
