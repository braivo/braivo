// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  assertUsableAt,
  assertValidTime,
  type KnowledgeEstimate,
  retrievability,
} from "./estimate.ts";
import { assertValidModel, type LearningModel } from "./model.ts";
import { isDue } from "./select.ts";

/**
 * Where a learner stands on one objective at a moment: what they have not met
 * yet, what they are still acquiring, and what they have retained and may be
 * forgetting. Discriminated by the estimate's own `phase`, with `unseen`
 * standing in for the estimate that does not exist, so each state carries
 * exactly the values that describe it.
 *
 * `due` is selection's rule, not a second one: a retained objective reported
 * as due is one selection would offer for review, were nothing more urgent.
 */
export type ObjectiveStanding = { objectiveId: string } & (
  | { phase: "unseen" }
  | { phase: "acquiring"; lastEvidenceAt: Date }
  | {
      phase: "retaining";
      lastEvidenceAt: Date;
      stability: number;
      retrievability: number;
      due: boolean;
    }
);

/**
 * Standings for a set of objectives, and the model that produced them. The
 * version travels once rather than on every standing, since one call is one
 * model; it is what keeps a stored report interpretable after the model moves.
 */
export type KnowledgeReport = {
  modelVersion: string;
  objectives: ObjectiveStanding[];
};

/**
 * Reports a learner's standing on each of `objectiveIds`, in the order given.
 *
 * The descriptive counterpart to `selectNext`, over the same inputs and held to
 * the same checks, so that what it reports is what selection would act on. It
 * decides nothing: an objective is reported whether or not anything would be
 * chosen, and an empty list reports nothing rather than failing.
 *
 * Order is the caller's, because the list is usually content order and a
 * report read in that order is the one a person can follow. A repeated ID is
 * reported each time it appears; this does not second-guess the list it was
 * given.
 */
export function assessKnowledge(input: {
  now: Date;
  objectiveIds: readonly string[];
  estimates: ReadonlyMap<string, KnowledgeEstimate>;
  model: LearningModel;
}): KnowledgeReport {
  const { now, objectiveIds, estimates, model } = input;
  assertValidModel(model);
  assertValidTime(now, "The `now` argument");

  return {
    modelVersion: model.version,
    objectives: objectiveIds.map((objectiveId): ObjectiveStanding => {
      const estimate = estimates.get(objectiveId);
      if (!estimate) return { objectiveId, phase: "unseen" };

      assertUsableAt(estimate, { objectiveId, now, model });
      const { lastEvidenceAt } = estimate;
      if (estimate.phase === "acquiring") {
        return { objectiveId, phase: "acquiring", lastEvidenceAt };
      }

      const r = retrievability(estimate, now);
      return {
        objectiveId,
        phase: "retaining",
        lastEvidenceAt,
        stability: estimate.stability,
        retrievability: r,
        due: isDue(r, model),
      };
    }),
  };
}
