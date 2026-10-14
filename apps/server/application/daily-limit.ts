// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Evidence } from "../learning/index.ts";
import { learnerDayIn } from "./learner-day.ts";

/**
 * How many objectives a learner may start in a day. Each one started brings
 * reviews for days after, so pacing new material keeps them within reach;
 * reviews themselves are never limited. Provisional
 * (docs/adr/0041-daily-limit.md).
 */
export const NEW_OBJECTIVES_PER_DAY = 20;

/**
 * The objectives a learner may be decided among now: all of `objectiveIds`,
 * less those not started yet once `NEW_OBJECTIVES_PER_DAY` were started today.
 * `heldBack` says whether any were left out, so a learner with nothing else to
 * do is told to come back tomorrow rather than that they are caught up.
 *
 * Counted from evidence, never a counter: an objective is started on the day
 * of its first evidence at the organization, a learner's day in `timeZone`
 * (`learnerDayIn`), so answering again counts nothing, an objective two courses
 * share counts once, and every course at the organization draws on one limit.
 * Evidence from elsewhere counts too: it brings the same reviews.
 */
export function limitNewObjectives(
  learner: {
    objectiveIds: readonly string[];
    evidence: readonly Evidence[];
  },
  input: { now: Date; timeZone: string },
): { candidates: readonly string[]; heldBack: boolean } {
  const { objectiveIds, evidence } = learner;

  const firstEvidenceAt = new Map<string, Date>();
  for (const { objectiveId, at } of evidence) {
    const first = firstEvidenceAt.get(objectiveId);
    if (first === undefined || at < first) firstEvidenceAt.set(objectiveId, at);
  }

  const dayOf = learnerDayIn(input.timeZone);
  const today = dayOf(input.now);
  let started = 0;
  for (const at of firstEvidenceAt.values()) if (dayOf(at) === today) started++;
  if (started < NEW_OBJECTIVES_PER_DAY) return { candidates: objectiveIds, heldBack: false };

  const candidates = objectiveIds.filter((id) => firstEvidenceAt.has(id));
  return { candidates, heldBack: candidates.length < objectiveIds.length };
}

/**
 * Whether `value` names a time zone `limitNewObjectives` can count days in, such
 * as "Europe/Warsaw".
 */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
