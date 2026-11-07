// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import {
  activeModel,
  assessKnowledge,
  type Evidence,
  replay,
  selectNext,
} from "../learning/index.ts";
import { dailyAllowance, NEW_OBJECTIVES_PER_DAY } from "./daily-limit.ts";
import { countWaiting, type CourseWaiting, decidePractice } from "./practice.ts";

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

describe("countWaiting", () => {
  /** As a list of courses reads it: assessed, with the day's allowance. */
  function waitingIn(
    objectiveIds: string[],
    evidence: Evidence[],
    withTasks: Set<string>,
    input = inUtc,
  ) {
    const { objectives } = assessKnowledge({
      now: input.now,
      objectiveIds,
      estimates: replay(evidence, activeModel),
      model: activeModel,
    });
    return countWaiting(objectives, withTasks, dailyAllowance(evidence, input).newLeft);
  }

  /**
   * What practice offers in turn, each answered right at once, no task resting (`waiting-rests.test.ts`):
   * the selection itself, which `countWaiting` must agree with.
   */
  function walkPractice(objectiveIds: string[], evidence: Evidence[], withTasks: Set<string>) {
    const offered: CourseWaiting = { learning: 0, dueForReview: 0, new: 0 };
    const answered = [...evidence];
    for (;;) {
      const course = learner(objectiveIds, answered);
      const practice = decidePractice(course, withTasks, inUtc);
      if (practice.kind !== "eligible") return offered;
      const decision = selectNext({
        now,
        candidates: practice.candidates,
        estimates: course.estimates,
        model: activeModel,
      })!;
      const why = { reteach: "learning", review: "dueForReview", introduce: "new" } as const;
      offered[why[decision.intent]]++;
      answered.push(result(decision.objectiveId, "success", now));
    }
  }

  /** Reaches a review: a success `initialStability` days and more ago. */
  const fourDaysAgo = minutesAgo(4 * 24 * 60);
  const startedToday = (count: number): Evidence[] => dayStartedAt(minutesAgo(60)).slice(0, count);

  test.each<{
    name: string;
    objectives: string[];
    evidence: Evidence[];
    withTasks: string[];
    waiting: CourseWaiting;
  }>([
    {
      name: "a mix, by why, nothing retained counted",
      objectives: ["missed", "overdue", "fresh", "new1", "new2"],
      evidence: [
        result("missed", "failure"),
        result("overdue", "success", fourDaysAgo),
        result("fresh", "success"),
      ],
      withTasks: ["missed", "overdue", "fresh", "new1", "new2"],
      waiting: { learning: 1, dueForReview: 1, new: 2 },
    },
    {
      name: "only what has a task, whatever it needs",
      objectives: ["missed", "overdue", "new1", "new2"],
      evidence: [result("missed", "failure"), result("overdue", "success", fourDaysAgo)],
      withTasks: ["new1"],
      waiting: { learning: 0, dueForReview: 0, new: 1 },
    },
    {
      name: "no more new ones than the day's limit still lets start",
      objectives: ["new1", "new2", "new3", "new4"],
      evidence: startedToday(NEW_OBJECTIVES_PER_DAY - 2),
      withTasks: ["new1", "new2", "new3", "new4"],
      waiting: { learning: 0, dueForReview: 0, new: 2 },
    },
    {
      name: "at the day's limit, what was started but nothing new",
      objectives: ["missed", "overdue", "new1"],
      evidence: [
        ...dayStartedAt(minutesAgo(60)),
        result("missed", "failure"),
        result("overdue", "success", fourDaysAgo),
      ],
      withTasks: ["missed", "overdue", "new1"],
      waiting: { learning: 1, dueForReview: 1, new: 0 },
    },
    {
      name: "nothing new once past the day's limit",
      objectives: ["new1"],
      evidence: [...dayStartedAt(minutesAgo(60)), result("extra", "success", minutesAgo(60))],
      withTasks: ["new1"],
      waiting: { learning: 0, dueForReview: 0, new: 0 },
    },
    {
      name: "places this course's own objectives took today gone",
      objectives: ["fresh", "new1", "new2"],
      evidence: [...startedToday(NEW_OBJECTIVES_PER_DAY - 2), result("fresh", "success")],
      withTasks: ["fresh", "new1", "new2"],
      waiting: { learning: 0, dueForReview: 0, new: 1 },
    },
    {
      name: "at the day's limit, what was started without a task left out",
      objectives: ["missed", "overdue", "due"],
      evidence: [
        ...dayStartedAt(minutesAgo(60)),
        result("missed", "failure"),
        result("overdue", "success", fourDaysAgo),
        result("due", "success", fourDaysAgo),
      ],
      withTasks: ["due"],
      waiting: { learning: 0, dueForReview: 1, new: 0 },
    },
    {
      name: "nothing when caught up",
      objectives: ["fresh"],
      evidence: [result("fresh", "success")],
      withTasks: ["fresh"],
      waiting: { learning: 0, dueForReview: 0, new: 0 },
    },
    {
      name: "nothing in a course without objectives",
      objectives: [],
      evidence: [],
      withTasks: [],
      waiting: { learning: 0, dueForReview: 0, new: 0 },
    },
  ])("counts what practice would select: $name", ({ objectives, evidence, withTasks, waiting }) => {
    const tasks = new Set(withTasks);
    expect(waitingIn(objectives, evidence, tasks)).toEqual(waiting);
    expect(walkPractice(objectives, evidence, tasks)).toEqual(waiting);
  });

  test("counts the day's limit in the zone it is given", () => {
    const at = new Date("2026-06-01T02:30:00Z");
    const evidence = dayStartedAt(new Date("2026-06-01T01:30:00Z"));
    const withTasks = new Set(["a"]);
    expect(waitingIn(["a"], evidence, withTasks, { now: at, timeZone: "UTC" }).new).toBe(0);
    expect(waitingIn(["a"], evidence, withTasks, { now: at, timeZone: "Europe/Warsaw" }).new).toBe(
      1,
    );
  });
});
