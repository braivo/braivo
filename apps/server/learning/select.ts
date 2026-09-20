// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AcquiringEstimate,
  assertUsableAt,
  assertValidTime,
  type KnowledgeEstimate,
  retrievability,
  type RetainingEstimate,
} from "./estimate.ts";
import { assertValidModel, type LearningModel } from "./model.ts";

/**
 * The selection rule's "due": retained, and recalled below target. Defined once
 * so that anything reporting an objective as due means exactly what selection
 * means by it, and the two cannot drift.
 */
export function isDue(retrievability: number, model: LearningModel): boolean {
  return retrievability < model.targetRetention;
}

/**
 * An objective and an intent, never an activity: choosing between a grammar
 * explanation, a cloze sentence, and a worked example requires the subject
 * knowledge this module deliberately lacks.
 *
 * The decision carries the rule-specific values that explain it, discriminated
 * by the same `intent` the caller already switches on, so a `review` cannot
 * exist without the retrievability that justified it — explainability is
 * structural rather than a field someone remembers to populate. It is not a
 * trace: candidate order, `now`, and the model's parameters are not repeated.
 *
 * It explains the decision at the moment it was made; `modelVersion` travels
 * with it so a persisted one stays interpretable, but historical
 * explainability needs more than this value.
 */
export type LearningDecision = {
  objectiveId: string;
  modelVersion: string;
} & (
  | { intent: "introduce" }
  | { intent: "reteach"; lastEvidenceAt: Date }
  | { intent: "review"; retrievability: number; stability: number }
);

/**
 * Picks what the learner should work on next, deterministically: acquiring
 * objectives first, then those whose recall has fallen below target, then new
 * material. Returns `undefined` when no candidate qualifies; what to do with a
 * learner who has nothing due is the application's decision.
 *
 * Eligibility is resolved before this is called — prerequisites, content-owner
 * settings, and availability produce `candidates`, whose order is content order.
 * Named arguments because four positional ones are easy to transpose.
 */
export function selectNext(input: {
  now: Date;
  candidates: readonly string[];
  estimates: ReadonlyMap<string, KnowledgeEstimate>;
  model: LearningModel;
}): LearningDecision | undefined {
  const { now, candidates, estimates, model } = input;
  assertValidModel(model);
  assertValidTime(now, "The `now` argument");

  // One pass in candidate order. A later candidate replaces an earlier one only
  // on a strict improvement, so position is the tie-breaker for every rule and
  // the order is total without comparing objective IDs.
  let acquiring: AcquiringEstimate | undefined;
  let due: { estimate: RetainingEstimate; retrievability: number } | undefined;
  let unseen: string | undefined;

  for (const objectiveId of candidates) {
    const estimate = estimates.get(objectiveId);

    if (!estimate) {
      unseen ??= objectiveId;
      continue;
    }

    const lastEvidenceTime = assertUsableAt(estimate, { objectiveId, now, model });

    if (estimate.phase === "acquiring") {
      if (!acquiring || lastEvidenceTime < acquiring.lastEvidenceAt.getTime()) {
        acquiring = estimate;
      }
      continue;
    }

    const r = retrievability(estimate, now);
    if (isDue(r, model) && (!due || r < due.retrievability)) {
      due = { estimate, retrievability: r };
    }
  }

  if (acquiring) {
    return {
      objectiveId: acquiring.objectiveId,
      modelVersion: model.version,
      intent: "reteach",
      lastEvidenceAt: acquiring.lastEvidenceAt,
    };
  }

  if (due) {
    return {
      objectiveId: due.estimate.objectiveId,
      modelVersion: model.version,
      intent: "review",
      retrievability: due.retrievability,
      stability: due.estimate.stability,
    };
  }

  if (unseen !== undefined) {
    return { objectiveId: unseen, modelVersion: model.version, intent: "introduce" };
  }

  return undefined;
}
