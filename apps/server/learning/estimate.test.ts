// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { type Evidence, type KnowledgeEstimate, replay, updateEstimate } from "./estimate.ts";
import { activeModel, type LearningModel } from "./model.ts";

const model = activeModel;
const day = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number) => new Date(start.getTime() + days * day);

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: "past-tense", outcome: "success", at: start, ...overrides };
}

function retaining(stability: number, lastEvidenceAt: Date): KnowledgeEstimate {
  return {
    objectiveId: "past-tense",
    phase: "retaining",
    stability,
    lastEvidenceAt,
    modelVersion: model.version,
  };
}

/** Asserts the phase while reading the number, so growth cases need no cast. */
function stabilityOf(estimate: KnowledgeEstimate): number {
  if (estimate.phase !== "retaining") {
    throw new Error(`Expected a retaining estimate, got "${estimate.phase}".`);
  }
  return estimate.stability;
}

/**
 * Deterministic shuffle. A permutation test has to fail reproducibly, so the
 * order comes from a seed rather than from `Math.random`.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed;
  for (let i = shuffled.length - 1; i > 0; i--) {
    // Lehmer, as the other generated tests use: its products stay below 2^53,
    // so no low bits are lost to rounding.
    state = (state * 48_271) % 2_147_483_647;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

describe("updateEstimate", () => {
  test("a first success enters retaining at the initial stability", () => {
    expect(updateEstimate(undefined, evidence(), model)).toEqual({
      objectiveId: "past-tense",
      phase: "retaining",
      stability: model.initialStability,
      lastEvidenceAt: start,
      modelVersion: model.version,
    });
  });

  test("a first failure is acquiring, not a weak memory", () => {
    expect(updateEstimate(undefined, evidence({ outcome: "failure" }), model)).toEqual({
      objectiveId: "past-tense",
      phase: "acquiring",
      lastEvidenceAt: start,
      modelVersion: model.version,
    });
  });

  test("a success while acquiring enters retaining at the initial stability", () => {
    const acquiring = updateEstimate(undefined, evidence({ outcome: "failure" }), model);
    const next = updateEstimate(acquiring, evidence({ id: "e2", at: at(1) }), model);

    expect(next).toMatchObject({ phase: "retaining", stability: model.initialStability });
  });

  test("a failure while acquiring stays acquiring and advances the timestamp", () => {
    const first = updateEstimate(undefined, evidence({ outcome: "failure" }), model);
    const next = updateEstimate(
      first,
      evidence({ id: "e2", outcome: "failure", at: at(3) }),
      model,
    );

    expect(next).toMatchObject({ phase: "acquiring", lastEvidenceAt: at(3) });
  });

  test("a success one stability interval later grows stability by 1 + gain * (1 - 0.9)", () => {
    const next = updateEstimate(retaining(1, start), evidence({ at: at(1) }), model);

    // r = 0.9 at one day, so the factor is 1 + 8 * 0.1.
    expect(stabilityOf(next)).toBeCloseTo(1.8, 10);
  });

  test("an overdue success grows stability more than an on-time one", () => {
    const next = updateEstimate(retaining(40, start), evidence({ at: at(120) }), model);

    // r = 0.9 ** 3 = 0.729, so the factor is 1 + 8 * 0.271.
    expect(stabilityOf(next)).toBeCloseTo(126.72, 2);
  });

  test("a success on an objective that was not due grows stability barely at all", () => {
    // 0.1 day after the last success, r is still ~0.9997.
    const next = updateEstimate(retaining(40, start), evidence({ at: at(0.1) }), model);

    expect(stabilityOf(next)).toBeCloseTo(40.084, 3);
  });

  test("growth is capped as a ratio, however overdue the success", () => {
    const next = updateEstimate(retaining(10, start), evidence({ at: at(1000) }), model);

    expect(stabilityOf(next)).toBe(10 * model.maxStabilityGrowth);
  });

  test("a lapse returns to acquiring and discards stability", () => {
    const next = updateEstimate(
      retaining(40, start),
      evidence({ outcome: "failure", at: at(10) }),
      model,
    );

    expect(next).toEqual({
      objectiveId: "past-tense",
      phase: "acquiring",
      lastEvidenceAt: at(10),
      modelVersion: model.version,
    });
  });

  test("rejects evidence older than what the estimate already folds in", () => {
    expect(() => updateEstimate(retaining(1, at(5)), evidence({ at: at(4) }), model)).toThrow(
      RangeError,
    );
  });

  test("accepts evidence at exactly the estimate's timestamp", () => {
    expect(() => updateEstimate(retaining(1, at(5)), evidence({ at: at(5) }), model)).not.toThrow();
  });

  test("rejects an invalid evidence timestamp instead of producing NaN stability", () => {
    expect(() => updateEstimate(undefined, evidence({ at: new Date("nonsense") }), model)).toThrow(
      RangeError,
    );
  });

  test("rejects an estimate carrying an invalid timestamp", () => {
    expect(() => updateEstimate(retaining(1, new Date("nonsense")), evidence(), model)).toThrow(
      RangeError,
    );
  });

  test("rejects evidence attributed to a different objective", () => {
    expect(() =>
      updateEstimate(retaining(1, start), evidence({ objectiveId: "subjunctive" }), model),
    ).toThrow(RangeError);
  });

  test("reviewed as each reaches the review threshold, an objective progresses as the spec documents", () => {
    // Stability is anchored at 0.9 and targetRetention is 0.9, so the threshold
    // is exactly `stability` days later, and every review there has r = 0.9 —
    // at the threshold rather than below it, where it would be due.
    const intervals: number[] = [];
    let estimate = updateEstimate(undefined, evidence({ at: start }), model);
    let reviewedAt = start;

    for (let review = 0; review < 4; review++) {
      const stability = stabilityOf(estimate);
      intervals.push(stability);
      reviewedAt = new Date(reviewedAt.getTime() + stability * day);
      estimate = updateEstimate(estimate, evidence({ id: `r${review}`, at: reviewedAt }), model);
    }
    intervals.push(stabilityOf(estimate));

    expect(intervals.map((days) => Math.round(days * 10) / 10)).toEqual([1, 1.8, 3.2, 5.8, 10.5]);
  });

  test.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects a stored estimate whose stability is %s",
    (stability) => {
      expect(() =>
        updateEstimate(retaining(stability, start), evidence({ at: at(1) }), model),
      ).toThrow(RangeError);
    },
  );

  test("rejects an estimate a different model version produced", () => {
    const stale = { ...retaining(1, start), modelVersion: "v0" };

    expect(() => updateEstimate(stale, evidence({ at: at(1) }), model)).toThrow(RangeError);
  });

  test.each<[string, Partial<LearningModel>]>([
    ["targetRetention at 1", { targetRetention: 1 }],
    ["targetRetention at 0", { targetRetention: 0 }],
    ["targetRetention NaN", { targetRetention: Number.NaN }],
    ["initialStability at 0", { initialStability: 0 }],
    ["infinite initialStability", { initialStability: Number.POSITIVE_INFINITY }],
    ["negative stabilityGain", { stabilityGain: -1 }],
    ["infinite stabilityGain", { stabilityGain: Number.POSITIVE_INFINITY }],
    ["maxStabilityGrowth below 1", { maxStabilityGrowth: 0.5 }],
    ["infinite maxStabilityGrowth", { maxStabilityGrowth: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => updateEstimate(undefined, evidence(), { ...model, ...overrides })).toThrow(
      RangeError,
    );
  });
});

describe("replay", () => {
  test("folds evidence in (at, id) order regardless of arrival order", () => {
    const ordered = [
      evidence({ id: "a", outcome: "failure", at: start }),
      evidence({ id: "b", at: at(1) }),
      evidence({ id: "c", at: at(2) }),
    ];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];

    expect(replay(shuffled, model)).toEqual(replay(ordered, model));
  });

  test("breaks colliding timestamps by ID rather than by arrival order", () => {
    const estimates = replay(
      [evidence({ id: "b", outcome: "failure" }), evidence({ id: "a", outcome: "success" })],
      model,
    );

    // The failure arrives first but sorts last, so it is the outcome that stands.
    expect(estimates.get("past-tense")).toMatchObject({ phase: "acquiring" });
  });

  test("orders colliding IDs by UTF-16 code unit, not by locale", () => {
    // "B" < "a" by code unit, while a typical locale collation puts "a" first.
    // The failure under "a" is therefore the later record, and the outcome that
    // stands.
    const estimates = replay(
      [evidence({ id: "a", outcome: "failure" }), evidence({ id: "B", outcome: "success" })],
      model,
    );

    expect(estimates.get("past-tense")).toMatchObject({ phase: "acquiring" });
  });

  test("follows the numbers of the model it is given", () => {
    // Different from the active model's in every parameter a success reads, so
    // a constant standing in for one of them would show.
    const custom = {
      ...model,
      version: "custom",
      initialStability: 3,
      stabilityGain: 2,
      maxStabilityGrowth: 1.5,
    };

    const first = replay([evidence()], custom).get("past-tense");
    expect(first).toMatchObject({ phase: "retaining", stability: 3, modelVersion: "custom" });

    // Long overdue, so r ≈ 0 and growth is 1 + 2, capped at 1.5.
    const grown = replay([evidence(), evidence({ id: "e2", at: at(1000) })], custom);
    expect(stabilityOf(grown.get("past-tense")!)).toBeCloseTo(4.5, 10);
  });

  test("is the only way from evidence to estimates the module exports", async () => {
    const learning = await import("./index.ts");

    expect(Object.keys(learning)).toContain("replay");
    expect(Object.keys(learning)).not.toContain("updateEstimate");
  });

  test("rejects an invalid model even when there is no evidence to fold", () => {
    expect(() => replay([], { ...model, targetRetention: 1 })).toThrow(RangeError);
  });

  test("keeps one estimate per objective across a multi-objective history", () => {
    const estimates = replay(
      [
        evidence({ id: "a", objectiveId: "past-tense" }),
        evidence({ id: "b", objectiveId: "fractions", outcome: "failure", at: at(1) }),
      ],
      model,
    );

    expect([...estimates.keys()].sort()).toEqual(["fractions", "past-tense"]);
    expect(estimates.get("fractions")).toMatchObject({ phase: "acquiring" });
    expect(estimates.get("past-tense")).toMatchObject({ phase: "retaining" });
  });

  test("does not mutate the caller's array", () => {
    const history = [evidence({ id: "b", at: at(1) }), evidence({ id: "a", at: start })];
    replay(history, model);

    expect(history.map((record) => record.id)).toEqual(["b", "a"]);
  });

  test("returns no estimates for no evidence", () => {
    expect(replay([], model).size).toBe(0);
  });

  test("is a function of the evidence set alone, whatever order it arrives in", () => {
    // Three objectives, interleaved, with failures, lapses, and timestamps that
    // collide across objectives — the shapes that make arrival order tempting to
    // depend on. Reconstructibility is the invariant estimates being disposable
    // rests on, so it is worth more than one fixture.
    const history: readonly Evidence[] = [
      evidence({ id: "e01", objectiveId: "past-tense", outcome: "failure", at: at(0) }),
      evidence({ id: "e02", objectiveId: "fractions", at: at(0) }),
      evidence({ id: "e03", objectiveId: "past-tense", at: at(1) }),
      evidence({ id: "e04", objectiveId: "fractions", at: at(1) }),
      evidence({ id: "e05", objectiveId: "derivatives", at: at(2) }),
      evidence({ id: "e06", objectiveId: "past-tense", at: at(3) }),
      evidence({ id: "e07", objectiveId: "fractions", outcome: "failure", at: at(5) }),
      evidence({ id: "e08", objectiveId: "derivatives", at: at(5) }),
      evidence({ id: "e09", objectiveId: "fractions", at: at(6) }),
      evidence({ id: "e10", objectiveId: "past-tense", at: at(9) }),
      evidence({ id: "e11", objectiveId: "derivatives", outcome: "failure", at: at(12) }),
      evidence({ id: "e12", objectiveId: "past-tense", at: at(20) }),
    ];
    const canonical = replay(history, model);

    expect([...canonical.keys()].sort()).toEqual(["derivatives", "fractions", "past-tense"]);
    for (let seed = 1; seed <= 50; seed++) {
      expect(replay(shuffle(history, seed), model)).toEqual(canonical);
    }
  });

  test("is the remedy for a stale version, deriving every estimate from the given model", () => {
    const estimates = replay([evidence()], { ...model, version: "v2" });

    expect(estimates.get("past-tense")).toMatchObject({ modelVersion: "v2" });
  });
});
