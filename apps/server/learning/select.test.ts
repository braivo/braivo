// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { type Evidence, type KnowledgeEstimate, replay } from "./estimate.ts";
import { activeModel } from "./model.ts";
import { selectNext } from "./select.ts";

const model = activeModel;
const day = 86_400_000;
const now = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * day);

function acquiring(objectiveId: string, lastEvidenceAt: Date): KnowledgeEstimate {
  return { objectiveId, phase: "acquiring", lastEvidenceAt, modelVersion: model.version };
}

function retaining(
  objectiveId: string,
  stability: number,
  lastEvidenceAt: Date,
): KnowledgeEstimate {
  return {
    objectiveId,
    phase: "retaining",
    stability,
    lastEvidenceAt,
    modelVersion: model.version,
  };
}

function select(candidates: readonly string[], ...estimates: readonly KnowledgeEstimate[]) {
  return selectNext({
    now,
    candidates,
    estimates: new Map(estimates.map((estimate) => [estimate.objectiveId, estimate])),
    model,
  });
}

describe("selectNext", () => {
  test("reviews by the target retention of the model it is given", () => {
    // Recalled at 0.85: due against a target of 0.9, not against one of 0.8.
    const elapsed = Math.log(0.85) / Math.log(0.9);
    const estimate = { ...retaining("a", 1, daysAgo(elapsed)), modelVersion: "custom" };
    const pick = (targetRetention: number) =>
      selectNext({
        now,
        candidates: ["a"],
        estimates: new Map([["a", estimate]]),
        model: { ...model, version: "custom", targetRetention },
      });

    expect(pick(0.9)).toMatchObject({ objectiveId: "a", intent: "review" });
    expect(pick(0.8)).toBeUndefined();
  });

  test("introduces new material when nothing is known", () => {
    expect(select(["a", "b"])).toEqual({
      objectiveId: "a",
      modelVersion: model.version,
      intent: "introduce",
    });
  });

  test("reteaches a failed first attempt, which a single-scalar model loses", () => {
    // The estimate is one instant old, so a low stability would put r at ~1:
    // neither due nor new, and the objective would drop out of selection.
    expect(select(["a", "b"], acquiring("a", now))).toEqual({
      objectiveId: "a",
      modelVersion: model.version,
      intent: "reteach",
      lastEvidenceAt: now,
    });
  });

  test("reviews an objective whose recall has fallen below target", () => {
    const decision = select(["a"], retaining("a", 40, daysAgo(120)));

    expect(decision).toMatchObject({ objectiveId: "a", intent: "review", stability: 40 });
    expect((decision as { retrievability: number }).retrievability).toBeCloseTo(0.729, 6);
  });

  test("a lapsed objective is selectable immediately, not after a reduced interval", () => {
    expect(select(["a", "b"], acquiring("a", now), retaining("b", 40, daysAgo(120)))).toMatchObject(
      {
        objectiveId: "a",
        intent: "reteach",
      },
    );
  });

  test("acquiring beats due, and due beats new", () => {
    const due = retaining("b", 1, daysAgo(10));

    expect(select(["a", "b", "c"], acquiring("a", now), due)).toMatchObject({ intent: "reteach" });
    expect(select(["a", "b", "c"], due)).toMatchObject({ objectiveId: "b", intent: "review" });
    expect(select(["a", "b", "c"])).toMatchObject({ objectiveId: "a", intent: "introduce" });
  });

  test("picks the oldest acquiring objective", () => {
    expect(
      select(["a", "b"], acquiring("a", daysAgo(1)), acquiring("b", daysAgo(9))),
    ).toMatchObject({ objectiveId: "b" });
  });

  test("picks the lowest retrievability among due objectives", () => {
    expect(
      select(["a", "b"], retaining("a", 10, daysAgo(11)), retaining("b", 1, daysAgo(11))),
    ).toMatchObject({ objectiveId: "b" });
  });

  test("breaks every tie by candidate order", () => {
    const sameAge = daysAgo(4);

    expect(select(["b", "a"], acquiring("a", sameAge), acquiring("b", sameAge))).toMatchObject({
      objectiveId: "b",
    });
    expect(
      select(["b", "a"], retaining("a", 10, daysAgo(20)), retaining("b", 10, daysAgo(20))),
    ).toMatchObject({ objectiveId: "b" });
  });

  test("does not select an objective above target for retention review", () => {
    // r = 0.9 ** (5 / 40) is well above target, so nothing qualifies.
    expect(select(["a"], retaining("a", 40, daysAgo(5)))).toBeUndefined();
  });

  test("an objective exactly at target is not yet due", () => {
    expect(select(["a"], retaining("a", 10, daysAgo(10)))).toBeUndefined();
  });

  test("introduces no unseen candidate while one is still being acquired", () => {
    // Not a rule written anywhere: rule 1 returns any objective still being
    // acquired, and rule 3 cannot reach an unseen candidate while rule 1 has one
    // to offer. An ordered candidate list is therefore enough to sequence new
    // material — which is not a claim that prerequisites would add nothing, only
    // that this much needs no notion of one. Pinned because the property is
    // emergent: nothing in the code states it, so nothing would notice it going.
    const history: Evidence[] = [];
    const offered: string[] = [];

    for (let step = 0; step < 6; step++) {
      const at = new Date(now.getTime() - (6 - step) * 60_000);
      const decision = selectNext({
        now: at,
        candidates: ["a", "b"],
        estimates: replay(history, model),
        model,
      });
      if (!decision) break;

      offered.push(`${decision.intent} ${decision.objectiveId}`);

      // The learner fails "a" three times before getting it, and passes after.
      const outcome = decision.objectiveId === "a" && step < 3 ? "failure" : "success";
      history.push({ id: `e${step}`, objectiveId: decision.objectiveId, outcome, at });
    }

    expect(offered).toEqual(["introduce a", "reteach a", "reteach a", "reteach a", "introduce b"]);
  });

  test("holds nothing back in a candidate list that omits the unlearned objective", () => {
    // The limit of the rule above, and the reason it is stated per candidate
    // list: the same learner, the same instant, the same unlearned "a". A course
    // that simply does not contain "a" introduces "b" as usual, which follows
    // from objectives being shared between courses rather than owned by one.
    const stuck: Evidence[] = [{ id: "e1", objectiveId: "a", outcome: "failure", at: daysAgo(1) }];
    const estimates = replay(stuck, model);

    expect(selectNext({ now, candidates: ["a", "b"], estimates, model })).toMatchObject({
      objectiveId: "a",
      intent: "reteach",
    });
    expect(selectNext({ now, candidates: ["b"], estimates, model })).toMatchObject({
      objectiveId: "b",
      intent: "introduce",
    });
  });

  test("returns undefined when no candidate qualifies", () => {
    expect(select([])).toBeUndefined();
  });

  test("ignores estimates for objectives that are not candidates", () => {
    expect(
      select(["a"], acquiring("b", daysAgo(1)), retaining("a", 40, daysAgo(1))),
    ).toBeUndefined();
  });

  test("rejects an estimate holding evidence from after now", () => {
    expect(() => select(["a"], acquiring("a", new Date(now.getTime() + day)))).toThrow(RangeError);
  });

  test("rejects an estimate filed under another objective's ID", () => {
    // Keyed by the candidate, holding another objective's estimate. Trusted, it
    // made selection return an objective that was never a candidate.
    expect(() =>
      selectNext({
        now,
        candidates: ["a"],
        estimates: new Map([["a", acquiring("b", daysAgo(1))]]),
        model,
      }),
    ).toThrow('filed under "a" is for "b"');
  });

  test("rejects an invalid timestamp rather than silently skipping the objective", () => {
    expect(() => select(["a"], retaining("a", 40, new Date("nonsense")))).toThrow(RangeError);
    expect(() =>
      selectNext({ now: new Date("nonsense"), candidates: ["a"], estimates: new Map(), model }),
    ).toThrow(RangeError);
  });

  test("rejects a candidate estimate whose stability has no retrievability curve", () => {
    // Unchecked, r would be NaN and the objective would read as "not due" for good.
    expect(() => select(["a"], retaining("a", 0, daysAgo(10)))).toThrow(RangeError);
  });

  test("rejects a candidate estimate a different model version produced", () => {
    const stale = { ...retaining("a", 40, daysAgo(1)), modelVersion: "v0" };

    expect(() => select(["a"], stale)).toThrow(RangeError);
  });

  test("rejects an invalid model", () => {
    expect(() =>
      selectNext({
        now,
        candidates: ["a"],
        estimates: new Map(),
        model: { ...model, targetRetention: 2 },
      }),
    ).toThrow(RangeError);
  });
});
