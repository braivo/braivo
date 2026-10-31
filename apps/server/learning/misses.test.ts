// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { assessKnowledge } from "./assess.ts";
import { type Evidence, replay } from "./estimate.ts";
import { missesSinceSuccess } from "./misses.ts";
import { activeModel } from "./model.ts";

const now = new Date("2026-06-01T00:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function record(
  id: string,
  outcome: Evidence["outcome"],
  at: Date,
  objectiveId = "past-tense",
): Evidence {
  return { id, objectiveId, outcome, at };
}

describe("missesSinceSuccess", () => {
  test("counts every failure of an objective never answered correctly", () => {
    expect(
      missesSinceSuccess(
        [
          record("a", "failure", minutesAgo(3)),
          record("b", "failure", minutesAgo(2)),
          record("c", "failure", minutesAgo(1), "fractions"),
          record("d", "failure", minutesAgo(1), "fractions"),
          record("e", "failure", minutesAgo(1), "fractions"),
        ],
        now,
      ),
    ).toEqual(
      new Map([
        ["past-tense", { count: 2, lastMissAt: minutesAgo(2), everSucceeded: false }],
        ["fractions", { count: 3, lastMissAt: minutesAgo(1), everSucceeded: false }],
      ]),
    );
  });

  test("counts from the latest success, and leaves out an objective it cleared", () => {
    expect(
      missesSinceSuccess(
        [
          record("a", "failure", minutesAgo(9)),
          record("b", "failure", minutesAgo(8)),
          record("c", "success", minutesAgo(7)),
          record("d", "failure", minutesAgo(6)),
          record("e", "success", minutesAgo(5), "fractions"),
          record("f", "failure", minutesAgo(4), "fractions"),
          record("g", "success", minutesAgo(3), "fractions"),
        ],
        now,
      ),
    ).toEqual(
      new Map([["past-tense", { count: 1, lastMissAt: minutesAgo(6), everSucceeded: true }]]),
    );
  });

  test("orders records at one moment by ID, as replay does, whatever order they arrive in", () => {
    const at = minutesAgo(1);
    const earlier = [record("a", "failure", minutesAgo(3)), record("b", "failure", minutesAgo(2))];
    // "s" sorts after "f": the success comes last and clears the misses.
    expect(
      missesSinceSuccess([record("s", "success", at), ...earlier, record("f", "failure", at)], now),
    ).toEqual(new Map());
    // "0" sorts before "f": the failure comes last, after the success.
    expect(
      missesSinceSuccess([record("f", "failure", at), ...earlier, record("0", "success", at)], now),
    ).toEqual(new Map([["past-tense", { count: 1, lastMissAt: at, everSucceeded: true }]]));
  });

  test("leaves out evidence dated after the moment it describes", () => {
    expect(
      missesSinceSuccess(
        [
          record("a", "failure", minutesAgo(1)),
          record("b", "failure", now),
          record("c", "failure", new Date(now.getTime() + 1)),
          record("d", "failure", new Date(now.getTime() + 1), "fractions"),
        ],
        now,
      ),
    ).toEqual(new Map([["past-tense", { count: 2, lastMissAt: now, everSucceeded: false }]]));
  });

  // Repeated misses are counted on an objective still being learned. Under the
  // active model a failure always leaves an objective acquiring and a success
  // always takes it out, so the two agree; the check names that agreement, so a
  // model where they part fails here rather than quietly flagging retained
  // objectives.
  test("counts misses exactly where the active model reports an objective as learning", () => {
    let state = 11;
    const random = () => {
      state = (state * 48_271) % 2_147_483_647;
      return state / 2_147_483_647;
    };
    const objectives = ["a", "b", "c", "d"];
    let learning = 0;
    for (let learner = 0; learner < 200; learner++) {
      const evidence = Array.from({ length: Math.floor(random() * 12) }, (_, index) =>
        record(
          `e${index}`,
          random() < 0.5 ? "success" : "failure",
          // Coarse times, so ties occur and are ordered by ID.
          minutesAgo(Math.floor(random() * 5)),
          objectives[Math.floor(random() * objectives.length)],
        ),
      );
      const misses = missesSinceSuccess(evidence, now);
      const report = assessKnowledge({
        now,
        objectiveIds: objectives,
        estimates: replay(evidence, activeModel),
        model: activeModel,
      });
      for (const standing of report.objectives) {
        expect([standing.objectiveId, misses.has(standing.objectiveId)]).toEqual([
          standing.objectiveId,
          standing.phase === "acquiring",
        ]);
        if (standing.phase === "acquiring") learning++;
      }
    }
    // A floor against a generator that never produces the case under test.
    expect(learning).toBeGreaterThan(100);
  });
});
