// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Version and parameters as one value, so they travel together and a caller
 * cannot pass a version apart from the numbers it names. Keeping them in step
 * is still a rule rather than a check: changing a parameter materially is a
 * new version and a recomputation of stored estimates, exactly as changing the
 * algorithm is, and nothing here can tell a parameter set from its version.
 */
export type LearningModel = {
  /** Identifies the algorithm and these parameter values together. */
  readonly version: string;
  /** Recall probability below which retention review is due. */
  readonly targetRetention: number;
  /** Stability, in days, on entering `retaining`. */
  readonly initialStability: number;
  /** Growth per success, scaled by retrieval difficulty. */
  readonly stabilityGain: number;
  /** Cap on the growth ratio a single success may apply. */
  readonly maxStabilityGrowth: number;
};

/**
 * The active model. These values are placeholders to be validated by replaying
 * recorded evidence, not tuned by intuition; bump `version` when one changes.
 *
 * Reviewed as each reaches the review threshold, an objective progresses
 * roughly 1 → 1.8 → 3.2 → 5.8 → 10.5 days: a success there has `r = 0.9`, so it
 * grows by `1 + 8 * 0.1`.
 */
export const activeModel: LearningModel = Object.freeze({
  version: "v1",
  targetRetention: 0.9,
  initialStability: 1,
  stabilityGain: 8,
  maxStabilityGrowth: 5,
});

/**
 * The module is pure, so failing fast is cheap. Each bound is written negated,
 * so that `NaN` fails it too, and the unbounded ones also require a finite
 * number: `Infinity` survives the arithmetic into a stability and produces an
 * estimate no comparison later reads as due.
 */
export function assertValidModel(model: LearningModel): void {
  if (!(model.targetRetention > 0 && model.targetRetention < 1)) {
    throw new RangeError(`targetRetention must be between 0 and 1, got ${model.targetRetention}.`);
  }
  if (!(Number.isFinite(model.initialStability) && model.initialStability > 0)) {
    throw new RangeError(
      `initialStability must be a finite number greater than 0, got ${model.initialStability}.`,
    );
  }
  if (!(Number.isFinite(model.stabilityGain) && model.stabilityGain >= 0)) {
    throw new RangeError(
      `stabilityGain must be a finite number of at least 0, got ${model.stabilityGain}.`,
    );
  }
  if (!(Number.isFinite(model.maxStabilityGrowth) && model.maxStabilityGrowth >= 1)) {
    throw new RangeError(
      `maxStabilityGrowth must be a finite number of at least 1, got ${model.maxStabilityGrowth}.`,
    );
  }
}
