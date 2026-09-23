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
  readObjective,
  type Objective,
  readObjectivesWithTasks,
  recordAttempt,
  RestingTask,
  RetiredTask,
} from "../persistence/index.ts";
import { hostAdmits, type RequestHost } from "./host.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";
import { isMember } from "./permission.ts";

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
 * How long a task rests after Braivo accepts a learner's answer to it, because
 * the grade reveals the answer. Provisional (docs/adr/0017-task-rest.md).
 */
const TASK_REST_MS = 10 * 60_000;

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
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
}): Promise<NextActivity> {
  const { database, learnerId, courseId, host, now } = input;

  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
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

  const [task, objective] = await Promise.all([
    readNextTask(database, { learnerId, objectiveId: decision.objectiveId }),
    readObjective(database, decision.objectiveId),
  ]);
  // An objective is never deleted while a course orders it, so only a task can
  // be missing: its last one was retired since, and the next asking skips it.
  if (task === undefined || objective === undefined) return { kind: "no-activity" };

  // Waiting rather than selecting again without this objective, which can
  // introduce unseen material ahead of it unless a second selection rule
  // prevents that (docs/adr/0017-task-rest.md).
  const restsUntil = restingUntil(task.lastAttemptAt, now);
  if (restsUntil !== undefined) return { kind: "resting", objective, retryAt: restsUntil };

  // JSON keeps the parts apart. `lastAttemptAt` reseeds the order after each
  // accepted answer and holds it across reloads.
  const seed = JSON.stringify([learnerId, task.id, task.lastAttemptAt?.getTime() ?? null]);
  return {
    kind: "decided",
    decision,
    objective,
    task: { id: task.id, ...presentTask(task.body, seed) },
  };
}

/** When a task answered at `lastAttemptAt` may be answered again, or nothing if it already may. */
function restingUntil(lastAttemptAt: Date | undefined, now: Date): Date | undefined {
  if (lastAttemptAt === undefined) return undefined;
  const until = new Date(lastAttemptAt.getTime() + TASK_REST_MS);
  return until > now ? until : undefined;
}

/**
 * As `NextObjective`, with the task to answer. `no-activity`, not `caught-up`:
 * a due objective may have no task (glossary: No activity). `resting`: every
 * task of the decided objective rests until `retryAt`; the decision is left
 * out, as it may no longer hold by then. Both name the objective, so a learner
 * is told what they are practising and not only why.
 */
export type NextActivity =
  | { kind: "unavailable" }
  | { kind: "no-activity" }
  | { kind: "resting"; objective: Objective; retryAt: Date }
  | {
      kind: "decided";
      decision: LearningDecision;
      objective: Objective;
      task: { id: string } & PresentedTask;
    };

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
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  attemptId: string;
  taskId: string;
  response: unknown;
  now: Date;
}): Promise<SubmittedAttempt> {
  const { database, learnerId, courseId, host, attemptId, taskId, now } = input;
  if (attemptId === "" || attemptId.length > MAX_ATTEMPT_ID_LENGTH) return { kind: "invalid" };

  const organizationId = await readCourseOrganization(database, courseId);
  if (organizationId === undefined) return { kind: "unavailable" };
  if (!(await hostAdmits(database, host, organizationId))) return { kind: "unavailable" };
  if (!(await isMember(database, { organizationId, userId: learnerId }))) {
    return { kind: "unavailable" };
  }

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
      // Enforced here too, not only by never offering a resting task: otherwise
      // a client could answer again straight after seeing the answer.
      restWindowStart: new Date(now.getTime() - TASK_REST_MS),
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
    if (error instanceof RestingTask) return { kind: "resting" };
    if (error instanceof RetiredTask) return { kind: "unavailable" };
    throw error;
  }

  return { kind: "graded", grade };
}

/**
 * `unavailable` is a missing course, one the learner is not in, a task outside
 * it, and a new attempt on a retired task, alike, as for `NextObjective`.
 * `invalid` is an attempt ID out of bounds or a response that cannot answer
 * this task; `conflict`, an attempt ID already used otherwise; `resting`, a
 * task this learner answered too recently to answer again yet.
 */
export type SubmittedAttempt =
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "resting" }
  | { kind: "graded"; grade: Grade };
