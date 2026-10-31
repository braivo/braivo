// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Evidence, inReplayOrder } from "./estimate.ts";

/**
 * Misses since the last success from which an objective still being learned
 * reads as repeated misses: a signal to check on the learner, not a diagnosis.
 * Provisional, to revisit once teachers' use shows what it should be. Not a
 * model parameter: it changes no estimate or selection, so no model version.
 */
export const REPEATED_MISSES_THRESHOLD = 3;

/** An objective's failures since its latest success, or since the first record without one. */
export type Misses = {
  /** At least 1: an objective without a miss since its last success has none. */
  count: number;
  lastMissAt: Date;
  everSucceeded: boolean;
};

/**
 * Each objective's misses up to `now`, counted in replay's order, so records at
 * one moment fall as they do in the estimates; an objective with none is left
 * out. Describes evidence and decides nothing, so it sits outside the model.
 */
export function missesSinceSuccess(
  evidence: readonly Evidence[],
  now: Date,
): ReadonlyMap<string, Misses> {
  const counted = new Map<string, Misses>();
  const succeeded = new Set<string>();
  for (const { objectiveId, outcome, at } of inReplayOrder(evidence)) {
    if (at.getTime() > now.getTime()) break;
    if (outcome === "success") {
      succeeded.add(objectiveId);
      counted.delete(objectiveId);
    } else {
      counted.set(objectiveId, {
        count: (counted.get(objectiveId)?.count ?? 0) + 1,
        lastMissAt: at,
        everSucceeded: succeeded.has(objectiveId),
      });
    }
  }
  return counted;
}
