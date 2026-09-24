// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type Grade,
  gradeResponse,
  parseTaskResponse,
  presentTask,
  type PresentedTask,
} from "../content/index.ts";
import { activeModel, type LearningDecision, selectNext } from "../learning/index.ts";
import {
  ConflictingAttempt,
  readCourseOrganization,
  readCourseTask,
  readNextTask,
  readOrganizationRoles,
  readObjectivesWithTasks,
  recordAttempt,
} from "../persistence/index.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";

/**
 * Starts the ID of every evidence record graded from an attempt. Reserved:
 * `recordGradedEvidence` refuses it, so an integrator's ID can never collide
 * with one an attempt will need.
 */
export const ATTEMPT_EVIDENCE_PREFIX = "attempt:";

/**
 * Room for a UUID or any reasonable client key. Unbounded, a long ID would
 * overflow PostgreSQL's index entry limit as an error rather than a refusal.
 */
const MAX_ATTEMPT_ID_LENGTH = 128;

/**
 * The learner loop's first half: the next objective and a task to practise it.
 * `chooseNextObjective` is the decision alone, for integrators with their own
 * tasks.
 *
 * Only objectives with a task are candidates, filtered before `learning` is
 * called (docs/specs/learning-model.md): selecting first would strand a learner
 * on an objective they cannot practise.
 */
export async function chooseNextActivity(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  now: Date;
}): Promise<NextActivity> {
  const { database, learnerId, courseId, now } = input;

  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    now,
    authorize: () => true,
  });
  if (learner === undefined) return { kind: "unavailable" };

  const withTasks = await readObjectivesWithTasks(database, learner.objectiveIds);
  const decision = selectNext({
    now,
    candidates: learner.objectiveIds.filter((id) => withTasks.has(id)),
    estimates: learner.estimates,
    model: activeModel,
  });
  if (decision === undefined) return { kind: "no-activity" };

  // The decision's objective had a task a moment ago, and nothing removes one.
  // Once retirement can, both reads must apply it, or this throws.
  const task = await readNextTask(database, { learnerId, objectiveId: decision.objectiveId });
  if (task === undefined) throw new Error(`Objective "${decision.objectiveId}" has no task.`);

  return { kind: "decided", decision, task: { id: task.id, ...presentTask(task.body) } };
}

/**
 * As `NextObjective`, with the task to answer. `no-activity`, not `caught-up`:
 * a due objective may have no task (glossary: No activity).
 */
export type NextActivity =
  | { kind: "unavailable" }
  | { kind: "no-activity" }
  | { kind: "decided"; decision: LearningDecision; task: { id: string } & PresentedTask };

/**
 * The loop's second half: grades a learner's answer and records the attempt
 * with its evidence. The learner submits for themselves, which posting evidence
 * does not allow, because Braivo grades: they choose the answer, never the
 * outcome. A retry under the same `attemptId` stores nothing twice and answers
 * the same grade (`recordAttempt`).
 */
export async function submitAttempt(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  attemptId: string;
  taskId: string;
  response: unknown;
  now: Date;
}): Promise<SubmittedAttempt> {
  const { database, learnerId, courseId, attemptId, taskId, now } = input;
  if (attemptId === "" || attemptId.length > MAX_ATTEMPT_ID_LENGTH) return { kind: "invalid" };

  const organizationId = await readCourseOrganization(database, courseId);
  if (organizationId === undefined) return { kind: "unavailable" };
  const roles = await readOrganizationRoles(database, { organizationId, userId: learnerId });
  if (roles.length === 0) return { kind: "unavailable" };

  const task = await readCourseTask(database, { courseId, taskId });
  if (task === undefined) return { kind: "unavailable" };

  const response = parseTaskResponse(task.body, input.response);
  if (response === undefined) return { kind: "invalid" };

  const grade = gradeResponse(task.body, response);
  try {
    await recordAttempt(database, {
      learnerId,
      attemptId,
      taskId,
      response,
      at: now,
      // Built from the attempt so that every attempt is its own evidence
      // (glossary: Evidence ID).
      evidence: {
        id: `${ATTEMPT_EVIDENCE_PREFIX}${attemptId}:${task.objectiveId}`,
        objectiveId: task.objectiveId,
        outcome: grade.outcome,
      },
    });
  } catch (error) {
    if (error instanceof ConflictingAttempt) return { kind: "conflict" };
    throw error;
  }

  return { kind: "graded", grade };
}

/**
 * `unavailable` is a missing course, one the learner is not in, and a task
 * outside it, alike, as for `NextObjective`. `invalid` is an attempt ID out of
 * bounds or a response that cannot answer this task; `conflict`, an attempt ID
 * already used otherwise.
 */
export type SubmittedAttempt =
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "graded"; grade: Grade };
