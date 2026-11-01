// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Evidence } from "../learning/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";

/**
 * When a learner last practised a course (progress-17): the latest attempt
 * answered in Braivo, Show answer's included, on any of `objectiveIds`, up to
 * `asOf`; `undefined` if none. An attempt is known by its evidence ID, a
 * prefix outside results may not use (`recordGradedEvidence`), so a result
 * recorded elsewhere never counts, whatever standing it earned. Attempts carry
 * no course: one on an objective this course shares counts here.
 */
export function lastPractised(
  evidence: readonly Evidence[],
  objectiveIds: ReadonlySet<string>,
  asOf: Date,
): Date | undefined {
  let latest: Date | undefined;
  for (const { id, objectiveId, at } of evidence) {
    // Readers already stop at `asOf` (progress-6); checked again, as `missesSinceSuccess` does.
    if (!id.startsWith(ATTEMPT_EVIDENCE_PREFIX) || !objectiveIds.has(objectiveId) || at > asOf)
      continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest;
}
