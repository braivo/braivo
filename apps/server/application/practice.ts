// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  activeModel,
  type Evidence,
  type KnowledgeEstimate,
  type LearningDecision,
  selectNext,
} from "../learning/index.ts";
import { limitNewObjectives, NEW_OBJECTIVES_PER_DAY } from "./daily-limit.ts";

/**
 * What practice the activity selection would offer a learner in a course now,
 * rests aside: the activity's decision, kept apart from reading tasks so that
 * it can decide again without one that retired meanwhile.
 *
 * In `chooseNextActivity`'s order: the daily limit on new objectives, then the
 * objectives with a task, then, only when none of those needs attention, those
 * without one (learner-loop-5). `withTasks`: which of the course's objectives
 * have a task to offer, the same for every learner.
 *
 * Pure: `now` and `timeZone` (the day `limitNewObjectives` counts in) are
 * arguments, and nothing is stored (docs/adr/0007-one-learning-model.md).
 */
export function decidePractice(
  learner: {
    objectiveIds: readonly string[];
    evidence: readonly Evidence[];
    estimates: ReadonlyMap<string, KnowledgeEstimate>;
  },
  withTasks: ReadonlySet<string>,
  input: { now: Date; timeZone: string },
): Practice {
  if (learner.objectiveIds.length === 0) return { kind: "empty" };
  const { now } = input;
  const { candidates, heldBack } = limitNewObjectives(learner, input);
  const select = (ids: readonly string[]) =>
    selectNext({ now, candidates: ids, estimates: learner.estimates, model: activeModel });

  const eligible = candidates.filter((id) => withTasks.has(id));
  if (select(eligible) !== undefined) return { kind: "eligible", candidates: eligible };

  const decision = select(candidates.filter((id) => !withTasks.has(id)));
  if (decision !== undefined) return { kind: "no-activity", decision };
  return heldBack ? { kind: "daily-limit", limit: NEW_OBJECTIVES_PER_DAY } : { kind: "caught-up" };
}

/**
 * `empty`: the course has no objective. `eligible`: an objective with a task
 * needs attention; `candidates` are those the selection runs over, in course
 * order, some of which may rest (docs/adr/0017-task-rest.md), so not yet an
 * answer to whether there is a question to ask now. `no-activity`: only
 * an objective without a task needs attention, `decision` naming it (glossary:
 * No activity). `daily-limit`, `caught-up`: as `NextActivity`.
 */
export type Practice =
  | { kind: "empty" }
  | { kind: "eligible"; candidates: readonly string[] }
  | { kind: "no-activity"; decision: LearningDecision }
  | { kind: "daily-limit"; limit: number }
  | { kind: "caught-up" };
