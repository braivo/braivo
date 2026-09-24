// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type Grade,
  gradeResponse,
  parseTaskResponse,
  presentTask,
  type TaskPrompt,
} from "../content/index.ts";
import { activeModel, type LearningDecision, selectNext } from "../learning/index.ts";
import {
  ConflictingAttempt,
  readCourseOrganization,
  readCourseTask,
  readNextTask,
  readOrganizationRoles,
  readTaskedObjectives,
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
 * The learner loop's first half: the next objective, and a task to practise it
 * with. `chooseNextObjective` answers the decision alone, for integrators who
 * bring their own tasks; this is for learners Braivo serves itself.
 *
 * Only objectives with a task are candidates. Content availability is
 * eligibility, resolved before `learning` is called (docs/specs/learning-model.md):
 * selecting first and finding no task would strand a learner on an objective
 * they cannot practise, where filtering lets selection move on to one they can.
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

  const tasked = await readTaskedObjectives(database, learner.objectiveIds);
  const decision = selectNext({
    now,
    candidates: learner.objectiveIds.filter((id) => tasked.has(id)),
    estimates: learner.estimates,
    model: activeModel,
  });
  if (decision === undefined) return { kind: "caught-up" };

  // The decision's objective had a task a moment ago, and nothing removes one.
  // Once retirement can, both reads must apply it, or this throws.
  const task = await readNextTask(database, { learnerId, objectiveId: decision.objectiveId });
  if (task === undefined) throw new Error(`Objective "${decision.objectiveId}" has no task.`);

  return { kind: "decided", decision, task: { id: task.id, ...presentTask(task.body) } };
}

/**
 * As `NextObjective`, with the task the learner is to answer. `caught-up` also
 * covers a course whose objectives have no tasks yet: nothing to practise now.
 */
export type NextActivity =
  | { kind: "unavailable" }
  | { kind: "caught-up" }
  | { kind: "decided"; decision: LearningDecision; task: { id: string } & TaskPrompt };

/**
 * The loop's second half: grades a learner's answer, and records the attempt and
 * the evidence graded from it, so the next `chooseNextActivity` reflects it.
 *
 * The learner submits for themselves. That is safe where posting evidence is
 * not, because Braivo grades: the learner chooses the answer, never the outcome.
 *
 * `attemptId` is the client's, so a retry after a lost response stores nothing
 * twice and answers the same grade (`recordAttempt`).
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
      // One record per objective the attempt assessed, each ID built from the
      // attempt so that every attempt is its own evidence (glossary: Evidence ID).
      evidence: [
        {
          id: `${ATTEMPT_EVIDENCE_PREFIX}${attemptId}:${task.objectiveId}`,
          objectiveId: task.objectiveId,
          outcome: grade.outcome,
          at: now,
        },
      ],
    });
  } catch (error) {
    if (error instanceof ConflictingAttempt) return { kind: "conflict" };
    throw error;
  }

  return { kind: "graded", grade };
}

/**
 * `unavailable` is a missing course, one the learner is not in, and a task
 * outside it, alike, as for `NextObjective`. `invalid` is a response that
 * cannot answer this task; `conflict`, an attempt ID already used otherwise.
 */
export type SubmittedAttempt =
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "graded"; grade: Grade };
