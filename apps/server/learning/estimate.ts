// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { assertValidModel, type LearningModel } from "./model.ts";

const DAY_MS = 86_400_000;

/**
 * Stability is defined as the elapsed time at which recall probability reaches
 * this value. The anchor is part of that definition and does not move when
 * `targetRetention` is tuned.
 */
const STABILITY_ANCHOR = 0.9;

/**
 * A normalized observation, produced by the grader at the task boundary — the
 * point where subject-specific knowledge stops. One attempt may produce
 * evidence for several objectives, each record attributed to exactly one.
 */
export type Evidence = {
  /** Evidence identity: breaks timestamp ties on replay, and the unique key under which a grading result is recorded once. */
  id: string;
  objectiveId: string;
  /** Binary, because no two graders agree on what a continuous score means. */
  outcome: "success" | "failure";
  at: Date;
};

/**
 * Three states, not two: `unseen` is the absence of an estimate, and a learner
 * who has failed an objective is `acquiring` rather than holding a weak memory
 * of it. Collapsing those makes a failed first attempt unselectable — its
 * retrievability is 1 the moment it is written, so it is neither due nor new.
 */
export type KnowledgeEstimate = AcquiringEstimate | RetainingEstimate;

export type AcquiringEstimate = {
  objectiveId: string;
  phase: "acquiring";
  lastEvidenceAt: Date;
  modelVersion: string;
};

export type RetainingEstimate = {
  objectiveId: string;
  phase: "retaining";
  /** Days until recall probability falls to 0.9. */
  stability: number;
  lastEvidenceAt: Date;
  modelVersion: string;
};

/**
 * Returns the timestamp, having rejected `Invalid Date`. Worth its own check
 * because `NaN` compares false against everything: a range check alone would
 * pass it straight through and silently produce a `NaN` stability.
 */
export function assertValidTime(date: Date, subject: string): number {
  const time = date.getTime();
  if (Number.isNaN(time)) throw new RangeError(`${subject} has an invalid timestamp.`);
  return time;
}

/**
 * Checks an estimate before anything is derived from it, and returns its
 * `lastEvidenceAt` in milliseconds — the value every caller needs next.
 * Nothing persists estimates yet, so in practice these arrive straight from
 * `replay`; the checks are here because `selectNext` and `assessKnowledge`
 * accept an estimate from any caller, and a cached one would be untrusted input.
 *
 * A version other than the given model's is stale input rather than a fallback:
 * folding new evidence into a stability an older model produced, or selecting on
 * one, yields state that replaying the learner's evidence cannot reproduce — the
 * invariant the rest of the design rests on. The remedy is always the same, so
 * the message says it. See docs/adr/0007-one-learning-model.md.
 *
 * A stability that is not finite and positive has no retrievability curve, and
 * every such value fails *quietly* rather than loudly: 0 gives `NaN`, a negative
 * gives `r > 1`, and `Infinity` gives `r = 1`. All three read as "not due", so
 * an unchecked one would drop the objective out of selection permanently.
 */
export function assertUsableEstimate(estimate: KnowledgeEstimate, model: LearningModel): number {
  if (estimate.modelVersion !== model.version) {
    throw new RangeError(
      `Estimate for "${estimate.objectiveId}" was computed by model "${estimate.modelVersion}", not the given model "${model.version}"; replay this learner's evidence first.`,
    );
  }
  if (
    estimate.phase === "retaining" &&
    !(Number.isFinite(estimate.stability) && estimate.stability > 0)
  ) {
    throw new RangeError(
      `Estimate for "${estimate.objectiveId}" has a stability of ${estimate.stability}, which has no retrievability curve.`,
    );
  }
  return assertValidTime(estimate.lastEvidenceAt, `Estimate for "${estimate.objectiveId}"`);
}

/**
 * What an entry point reading estimates at a moment checks before using one:
 * everything `assertUsableEstimate` checks, and two things only a reader can.
 * Returns the estimate's `lastEvidenceAt` in milliseconds.
 *
 * The estimate has to be the one for the objective it was looked up under. A
 * map is keyed separately from the estimates it holds, so a hand-built one can
 * file one objective's estimate under another's ID, and a reader trusting the
 * value would then answer about an objective nobody asked for — selection would
 * return one that was never a candidate. `replay` never builds such a map; the
 * check is for the callers that do not use it.
 *
 * And nothing folded into it may be dated after `now`. Retrievability clamps
 * elapsed time at zero, so such an estimate reads as freshly recalled — not due,
 * however stale it really is.
 */
export function assertUsableAt(
  estimate: KnowledgeEstimate,
  input: { objectiveId: string; now: Date; model: LearningModel },
): number {
  if (estimate.objectiveId !== input.objectiveId) {
    throw new RangeError(
      `The estimate filed under "${input.objectiveId}" is for "${estimate.objectiveId}".`,
    );
  }
  const lastEvidenceTime = assertUsableEstimate(estimate, input.model);
  if (lastEvidenceTime > input.now.getTime()) {
    throw new RangeError(
      `Estimate for "${estimate.objectiveId}" holds evidence at ${estimate.lastEvidenceAt.toISOString()}, after now (${input.now.toISOString()}).`,
    );
  }
  return lastEvidenceTime;
}

/**
 * Derived, never stored. Elapsed time is a clamped duration rather than a
 * calendar-day subtraction, so time zones and DST cannot leak into a model that
 * claims determinism.
 */
export function retrievability(estimate: RetainingEstimate, at: Date): number {
  const elapsedDays = Math.max(0, at.getTime() - estimate.lastEvidenceAt.getTime()) / DAY_MS;
  return STABILITY_ANCHOR ** (elapsedDays / estimate.stability);
}

/**
 * Folds one evidence record into an objective's estimate. Accepts `undefined`
 * for the unseen case so callers need not branch, which is what keeps the
 * three-state model from needing a fourth representation.
 */
export function updateEstimate(
  estimate: KnowledgeEstimate | undefined,
  evidence: Evidence,
  model: LearningModel,
): KnowledgeEstimate {
  assertValidModel(model);
  const evidenceTime = assertValidTime(evidence.at, `Evidence "${evidence.id}"`);

  if (estimate) {
    if (estimate.objectiveId !== evidence.objectiveId) {
      throw new RangeError(
        `Evidence for "${evidence.objectiveId}" cannot update the estimate for "${estimate.objectiveId}".`,
      );
    }
    const estimateTime = assertUsableEstimate(estimate, model);
    // An estimate cannot absorb evidence older than what is already folded into
    // it. `replay` guarantees this by ordering; a direct call is the one place
    // a caller can get it wrong.
    if (evidenceTime < estimateTime) {
      throw new RangeError(
        `Evidence at ${evidence.at.toISOString()} predates the estimate for "${estimate.objectiveId}" at ${estimate.lastEvidenceAt.toISOString()}.`,
      );
    }
  }

  const base = {
    objectiveId: evidence.objectiveId,
    lastEvidenceAt: evidence.at,
    modelVersion: model.version,
  };

  // A failure returns the objective to `acquiring` from every phase. Discarding
  // stability on a lapse is deliberate: penalizing it instead would reset
  // retrievability to 1, leaving the objective not due for days the learner has
  // just demonstrably failed it. It is also why no lapse factor, stability
  // floor, or consecutive-failure counter is needed.
  if (evidence.outcome === "failure") {
    return { ...base, phase: "acquiring" };
  }

  const stability =
    estimate?.phase === "retaining"
      ? grownStability(estimate, evidence.at, model)
      : model.initialStability;

  return { ...base, phase: "retaining", stability };
}

/**
 * Stability grows more when retrieval was harder, so a later, more effortful
 * recall is worth more than an early one. The cap bounds the ratio rather than
 * stability itself, so a very overdue success cannot inflate it without bound.
 */
function grownStability(estimate: RetainingEstimate, at: Date, model: LearningModel): number {
  // Evaluated at the evidence's own time, which is what makes this meaningful
  // for an objective that was not due — a multi-objective task produces exactly
  // that, and `1 - r ≈ 0` correctly grows such an objective barely at all.
  const r = retrievability(estimate, at);
  const growth = Math.min(1 + model.stabilityGain * (1 - r), model.maxStabilityGrowth);
  return estimate.stability * growth;
}

/**
 * Rebuilds every estimate implied by a learner's evidence. It owns the `(at,
 * id)` ordering that the disposable-estimate invariant rests on, so that order
 * lives in one place instead of being re-derived at each call site. Evidence may
 * span any number of objectives; the result is the shape `selectNext` consumes.
 */
export function replay(
  evidence: readonly Evidence[],
  model: LearningModel,
): ReadonlyMap<string, KnowledgeEstimate> {
  assertValidModel(model);

  const estimates = new Map<string, KnowledgeEstimate>();
  for (const record of [...evidence].sort(byEvidenceOrder)) {
    estimates.set(
      record.objectiveId,
      updateEstimate(estimates.get(record.objectiveId), record, model),
    );
  }
  return estimates;
}

/**
 * Order on `(at, id)`: timestamps collide and graders retry, so an order that
 * does not depend on arrival is what makes replay reproducible. It is total for
 * evidence whose IDs are unique, as evidence identity requires; replay does not
 * deduplicate. IDs compare by UTF-16 code unit — the fixed order `<` gives —
 * never by locale, which would reintroduce the non-determinism this removes.
 */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.at.getTime() !== b.at.getTime()) return a.at.getTime() - b.at.getTime();
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
