// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence, replay } from "../learning/index.ts";
import { NEW_OBJECTIVES_PER_DAY } from "./daily-limit.ts";
import { decidePractice } from "./practice.ts";

const now = new Date("2026-06-01T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

/** A learner in a course of `objectiveIds`, with `evidence`. */
function learner(objectiveIds: string[], evidence: Evidence[] = []) {
  return { objectiveIds, evidence, estimates: replay(evidence, activeModel) };
}

const result = (objectiveId: string, outcome: Evidence["outcome"], at = minutesAgo(1)) => ({
  id: `${objectiveId}:${outcome}@${at.toISOString()}`,
  objectiveId,
  outcome,
  at,
});

/** A day's worth of objectives started at `at`, elsewhere at the organization. */
const dayStartedAt = (at: Date): Evidence[] =>
  Array.from({ length: NEW_OBJECTIVES_PER_DAY }, (_, i) => result(`elsewhere-${i}`, "success", at));

const inUtc = { now, timeZone: "UTC" };

describe("decidePractice", () => {
  test("is empty for a course without objectives, before anything else", () => {
    expect(decidePractice(learner([]), new Set(), inUtc)).toEqual({ kind: "empty" });
  });

  test("is eligible among the objectives with a task, in course order, while one needs attention", () => {
    expect(decidePractice(learner(["a", "b", "c"]), new Set(["b", "c"]), inUtc)).toEqual({
      kind: "eligible",
      candidates: ["b", "c"],
    });
  });

  test("never lets an objective without a task hold up one with a task", () => {
    // `a` is acquiring, which selection ranks first, but has nothing to practise it with.
    const evidence = [result("a", "failure")];
    expect(decidePractice(learner(["a", "b"], evidence), new Set(["b"]), inUtc)).toEqual({
      kind: "eligible",
      candidates: ["b"],
    });
  });

  test("is no activity on the objective without a task that selection decides next", () => {
    const evidence = [result("b", "success")];
    expect(decidePractice(learner(["a", "b", "c"], evidence), new Set(["b"]), inUtc)).toEqual({
      kind: "no-activity",
      decision: { objectiveId: "a", modelVersion: activeModel.version, intent: "introduce" },
    });
  });

  test("is caught up when nothing needs attention, tasks or not", () => {
    const evidence = [result("a", "success"), result("b", "success")];
    expect(decidePractice(learner(["a", "b"], evidence), new Set(["a"]), inUtc)).toEqual({
      kind: "caught-up",
    });
  });

  test("says the daily limit, not blocked or caught up, once only new objectives are left", () => {
    const evidence = [...dayStartedAt(minutesAgo(60)), result("a", "success")];
    const course = learner(["a", "b", "c"], evidence);
    const limit = { kind: "daily-limit", limit: NEW_OBJECTIVES_PER_DAY };
    // `b` has a task and `c` none: held back alike.
    expect(decidePractice(course, new Set(["a", "b"]), inUtc)).toEqual(limit);
    expect(decidePractice(course, new Set(["a"]), inUtc)).toEqual(limit);
  });

  test("counts the day from 04:00 in the zone it is given", () => {
    // 01:30 UTC is 03:30 in Warsaw (summer): yesterday there until 04:00.
    // At 02:30 UTC, 04:30 in Warsaw, a new day began there; in UTC it is still
    // the day those objectives were started.
    const at = new Date("2026-06-01T02:30:00Z");
    const course = learner(["a"], dayStartedAt(new Date("2026-06-01T01:30:00Z")));
    const withTasks = new Set(["a"]);
    expect(decidePractice(course, withTasks, { now: at, timeZone: "UTC" })).toEqual({
      kind: "daily-limit",
      limit: NEW_OBJECTIVES_PER_DAY,
    });
    expect(decidePractice(course, withTasks, { now: at, timeZone: "Europe/Warsaw" })).toEqual({
      kind: "eligible",
      candidates: ["a"],
    });
    // Without a task, the same learner is blocked in one zone and held in the other.
    expect(decidePractice(course, new Set(), { now: at, timeZone: "Europe/Warsaw" })).toMatchObject(
      { kind: "no-activity", decision: { objectiveId: "a" } },
    );
  });
});
