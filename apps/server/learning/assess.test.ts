// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { assessKnowledge } from "./assess.ts";
import type { KnowledgeEstimate } from "./estimate.ts";
import { activeModel, type LearningModel } from "./model.ts";
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

function keyed(estimates: readonly KnowledgeEstimate[]): Map<string, KnowledgeEstimate> {
  return new Map(estimates.map((estimate) => [estimate.objectiveId, estimate]));
}

function assess(objectiveIds: readonly string[], ...estimates: readonly KnowledgeEstimate[]) {
  return assessKnowledge({ now, objectiveIds, estimates: keyed(estimates), model });
}

describe("assessKnowledge", () => {
  test("reports each phase with the values that describe it", () => {
    const report = assess(
      ["new", "failed", "kept"],
      acquiring("failed", daysAgo(1)),
      retaining("kept", 10, daysAgo(10)),
    );

    expect(report).toEqual({
      modelVersion: model.version,
      objectives: [
        { objectiveId: "new", phase: "unseen" },
        { objectiveId: "failed", phase: "acquiring", lastEvidenceAt: daysAgo(1) },
        {
          objectiveId: "kept",
          phase: "retaining",
          lastEvidenceAt: daysAgo(10),
          stability: 10,
          // Stability is the interval at which recall falls to 0.9.
          retrievability: 0.9,
          due: false,
        },
      ],
    });
  });

  test("reports a retained objective as due once recall falls below target", () => {
    const [objective] = assess(["a"], retaining("a", 1, daysAgo(10))).objectives;

    expect(objective).toMatchObject({ phase: "retaining", due: true });
    expect((objective as { retrievability: number }).retrievability).toBeCloseTo(0.9 ** 10, 10);
  });

  test("does not report an objective exactly at target as due, as selection does not", () => {
    expect(assess(["a"], retaining("a", 5, daysAgo(5))).objectives[0]).toMatchObject({
      due: false,
    });
  });

  test("keeps the order it was given, not an order of its own", () => {
    const ids = ["c", "a", "b"];

    expect(assess(ids).objectives.map((standing) => standing.objectiveId)).toEqual(ids);
  });

  test("leaves out estimates for objectives it was not asked about", () => {
    expect(assess(["a"], acquiring("b", daysAgo(1))).objectives).toEqual([
      { objectiveId: "a", phase: "unseen" },
    ]);
  });

  test("reports nothing, rather than failing, for no objectives", () => {
    expect(assess([])).toEqual({ modelVersion: model.version, objectives: [] });
  });

  test("rejects an estimate filed under another objective's ID", () => {
    // Trusted, this would report objective b's standing under a's name.
    expect(() =>
      assessKnowledge({
        now,
        objectiveIds: ["a"],
        estimates: new Map([["a", acquiring("b", daysAgo(1))]]),
        model,
      }),
    ).toThrow('filed under "a" is for "b"');
  });

  test("rejects an estimate holding evidence from after now", () => {
    // Retrievability clamps elapsed time at zero, so this would read as freshly
    // recalled rather than raising anything.
    expect(() => assess(["a"], retaining("a", 1, new Date(now.getTime() + day)))).toThrow(
      RangeError,
    );
  });

  test("rejects what selection rejects", () => {
    const foreign = { ...retaining("a", 1, daysAgo(1)), modelVersion: "v0" };
    const unusable = retaining("a", 0, daysAgo(1));

    expect(() => assess(["a"], foreign)).toThrow(RangeError);
    expect(() => assess(["a"], unusable)).toThrow(RangeError);
    expect(() =>
      assessKnowledge({ now: new Date("nonsense"), objectiveIds: [], estimates: new Map(), model }),
    ).toThrow(RangeError);
    expect(() =>
      assessKnowledge({
        now,
        objectiveIds: [],
        estimates: new Map(),
        model: { ...model, targetRetention: 1 } satisfies LearningModel,
      }),
    ).toThrow(RangeError);
  });
});

/**
 * Deterministic generator, so a failure names a case that can be run again.
 * Lehmer's constants keep the product exactly representable.
 */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

describe("assessKnowledge alongside selectNext", () => {
  // The report exists to show what selection acts on, and the two are
  // separate functions that could come to disagree. Across many generated
  // learners, whatever selection chooses has to be visible in the report as the
  // reason it was chosen, and when selection chooses nothing the report must
  // show nothing that would have been chosen.
  test("agree about every generated learner", () => {
    const random = generator(7);
    const ids = ["o0", "o1", "o2", "o3", "o4"];
    const intents = new Map<string, number>();

    for (let learner = 0; learner < 2_000; learner++) {
      // Drawn per learner rather than per objective. Independent draws make a
      // learner with nothing to do almost impossible — one in two thousand —
      // and that is the case where a report showing something due would matter
      // most. So each learner decides whether anything is being re-taught,
      // whether anything is new, and how well the rest is held.
      const reteaching = random() < 0.25;
      const withNew = random() < 0.5;
      const hold = [0.2, 1, 5][Math.floor(random() * 3)]!;

      const estimates: KnowledgeEstimate[] = [];
      for (const id of ids) {
        const roll = random();
        const at = daysAgo(random() * 40);
        if (reteaching && roll < 0.4) estimates.push(acquiring(id, at));
        else if (!(withNew && roll > 0.6)) {
          estimates.push(retaining(id, (1 + random() * 40) * hold, at));
        }
      }

      const input = { now, estimates: keyed(estimates), model };
      const decision = selectNext({ ...input, candidates: ids });
      const standings = assessKnowledge({ ...input, objectiveIds: ids }).objectives;
      const standing = (id: string) => standings.find((one) => one.objectiveId === id);
      const reteachable = standings.some((one) => one.phase === "acquiring");
      const reviewable = standings.some((one) => one.phase === "retaining" && one.due);
      const introducible = standings.some((one) => one.phase === "unseen");

      const context = `learner ${learner}: ${JSON.stringify(decision)}`;
      const intent = decision?.intent ?? "nothing";
      intents.set(intent, (intents.get(intent) ?? 0) + 1);
      switch (decision?.intent) {
        case "reteach":
          expect(standing(decision.objectiveId)?.phase, context).toBe("acquiring");
          break;
        case "review":
          expect(reteachable, context).toBe(false);
          expect(standing(decision.objectiveId), context).toMatchObject({
            phase: "retaining",
            due: true,
            retrievability: decision.retrievability,
          });
          break;
        case "introduce":
          expect([reteachable, reviewable], context).toEqual([false, false]);
          expect(standing(decision.objectiveId)?.phase, context).toBe("unseen");
          break;
        case undefined:
          expect([reteachable, reviewable, introducible], context).toEqual([false, false, false]);
          break;
      }
    }

    // Asserted rather than assumed: a branch that never ran agrees vacuously,
    // and the first version of this generator reached "nothing" once.
    for (const intent of ["reteach", "review", "introduce", "nothing"]) {
      expect(intents.get(intent) ?? 0, intent).toBeGreaterThan(100);
    }
  });
});
