// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  activeModel,
  type Evidence,
  type KnowledgeEstimate,
  type LearningDecision,
  type ObjectiveStanding,
  selectNext,
} from "../learning/index.ts";
import { limitNewObjectives, NEW_OBJECTIVES_PER_DAY } from "./daily-limit.ts";
import { countStandings } from "./standing.ts";

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
 * What the activity's selection can offer in a course now, a snapshot rather
 * than a session's length (answering can end a rest): `assessed`, its
 * objectives' standings (assessment shares selection's rule), those
 * `offerable`, having a task that does not rest, with no more new ones than
 * `newLeft` (`dailyAllowance`). Over this course alone: the limit is shared
 * across the organization, so two courses may count the same places left today.
 *
 * Counted by standing, not by walking `selectNext`, which is quadratic in what
 * waits; `practice.test.ts` walks it, nothing resting, to prove the two agree,
 * and `waiting-rests.test.ts` compares rests with the activity's. Takes what its
 * caller already has, so a list of courses scans no history per course.
 */
export function countWaiting(
  assessed: readonly ObjectiveStanding[],
  offerable: ReadonlySet<string>,
  newLeft: number,
): CourseWaiting {
  const { learning, dueForReview, notStarted } = countStandings(
    assessed.filter(({ objectiveId }) => offerable.has(objectiveId)),
  );
  return { learning, dueForReview, new: Math.min(notStarted, newLeft) };
}

/** How many of a course's objectives practice would offer now, by why. */
export type CourseWaiting = { learning: number; dueForReview: number; new: number };

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
