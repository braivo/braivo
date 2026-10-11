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
  countOtherAttempts,
  readCourseOrganization,
  readCourseTask,
  readNextTask,
  readObjective,
  type Objective,
  readObjectivesWithTasks,
  readTaskCitations,
  recordAttempt,
  RestingTask,
  RetiredTask,
} from "../persistence/index.ts";
import { NEW_OBJECTIVES_PER_DAY, limitNewObjectives } from "./daily-limit.ts";
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
 * A task rests after Braivo accepts a learner's answer to it, because the grade
 * reveals the answer: for ten minutes, or until three attempts on other
 * objectives, whichever ends first. Provisional (docs/adr/0017-task-rest.md).
 */
const TASK_REST_MS = 10 * 60_000;
const TASK_REST_ATTEMPTS = 3;

/**
 * The learner loop's first half: the next objective and a task to practise it.
 * `chooseNextObjective` is the decision alone, for integrators with their own
 * tasks.
 *
 * Objectives with a task are selected from first, filtered before `learning` is
 * called (docs/specs/learning-model.md), so one without never holds up those
 * with one; it is decided, as no activity, only when none of those needs
 * attention or rests. Whether one made acquiring by outside evidence should
 * instead hold back later material is open (docs/specs/learner-loop.md, Gaps).
 */
export async function chooseNextActivity(input: {
  database: Database;
  learnerId: string;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
  /** The learner's, an IANA name, for the day `limitNewObjectives` counts in. */
  timeZone: string;
}): Promise<NextActivity> {
  const { database, learnerId, courseId, host, now, timeZone } = input;

  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
    now,
    authorize: () => true,
  });
  if (learner === undefined) return { kind: "unavailable" };

  const select = (candidates: readonly string[]) =>
    selectNext({ now, candidates, estimates: learner.estimates, model: activeModel });
  const { candidates, heldBack } = limitNewObjectives(learner, { now, timeZone });
  const withTasks = await readObjectivesWithTasks(database, candidates);
  let tasked = candidates.filter((id) => withTasks.has(id));

  // While every task of the decided objective rests, select again without it,
  // so a learner practises something else, unseen objectives included
  // (docs/adr/0017-task-rest.md). `acquiring` outranks the rest, so it comes
  // back first once its rest ends.
  let resting: { objective: Objective; retryAt: Date } | undefined;
  for (let decision = select(tasked); decision !== undefined; decision = select(tasked)) {
    const { objectiveId } = decision;
    const [task, objective] = await Promise.all([
      readNextTask(database, { learnerId, objectiveId }),
      readObjective(database, objectiveId),
    ]);
    // Never missing: its course references it, with deletes restricted.
    if (objective === undefined) throw new Error(`Objective ${objectiveId} is missing`);
    // Its last task was retired since `withTasks` was read: one without a task now.
    if (task === undefined) {
      withTasks.delete(objectiveId);
      tasked = tasked.filter((id) => id !== objectiveId);
      continue;
    }

    const retryAt = await restingUntil(database, {
      learnerId,
      organizationId: learner.organizationId,
      objectiveId,
      lastAttemptAt: task.lastAttemptAt,
      now,
    });
    if (retryAt === undefined) {
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

    if (resting === undefined || retryAt < resting.retryAt) resting = { objective, retryAt };
    tasked = tasked.filter((id) => id !== objectiveId);
  }
  if (resting !== undefined) return { kind: "resting", ...resting };

  const decision = select(candidates.filter((id) => !withTasks.has(id)));
  if (decision === undefined) {
    return heldBack
      ? { kind: "daily-limit", limit: NEW_OBJECTIVES_PER_DAY }
      : { kind: "caught-up" };
  }
  const objective = await readObjective(database, decision.objectiveId);
  if (objective === undefined) throw new Error(`Objective ${decision.objectiveId} is missing`);
  return { kind: "no-activity", decision, objective };
}

/**
 * When a task the learner last answered at `lastAttemptAt` may be offered
 * again, or nothing if it already may: after `TASK_REST_MS`, unless
 * `TASK_REST_ATTEMPTS` other objectives' attempts end the rest sooner. Ten
 * minutes is when it ends if nothing else is answered meanwhile.
 */
async function restingUntil(
  database: Database,
  input: {
    learnerId: string;
    organizationId: string;
    objectiveId: string;
    lastAttemptAt: Date | undefined;
    now: Date;
  },
): Promise<Date | undefined> {
  const { lastAttemptAt, now } = input;
  if (lastAttemptAt === undefined) return undefined;
  const until = new Date(lastAttemptAt.getTime() + TASK_REST_MS);
  if (until <= now) return undefined;
  const attempts = await countOtherAttempts(database, { ...input, after: lastAttemptAt });
  return attempts < TASK_REST_ATTEMPTS ? until : undefined;
}

/**
 * As `NextObjective`, with the task to answer. `no-activity`: the decided
 * objective has no task (glossary: No activity). `resting`: every objective
 * with a task that needs attention has only resting tasks, ahead of any without
 * one, and `objective`'s rest is the first to end, at `retryAt`; the decision is left out, as it may no longer hold by
 * then. These three name the objective, so a learner sees what they practise,
 * or what holds them up, not only why. `daily-limit`: nothing else needs
 * attention, and objectives not started yet wait for tomorrow
 * (`limitNewObjectives`).
 */
export type NextActivity =
  | { kind: "unavailable" }
  | { kind: "caught-up" }
  | { kind: "daily-limit"; limit: number }
  | { kind: "no-activity"; decision: LearningDecision; objective: Objective }
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
 * the outcome recorded (`recordAttempt`), with feedback rebuilt from the task.
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
  let outcome: Grade["outcome"];
  try {
    outcome = await recordAttempt(database, {
      learnerId,
      organizationId,
      attemptId,
      taskId,
      response,
      at: now,
      // Enforced here too, not only by never offering a resting task: otherwise
      // a client could answer again straight after seeing the answer.
      restWindowStart: new Date(now.getTime() - TASK_REST_MS),
      restAttempts: TASK_REST_ATTEMPTS,
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

  // Read only now, once graded: shown before answering, a passage could give
  // the answer away. Nothing distinguishes source from learner here, so the
  // learner sees the quote and where it is from, never the source's whole text.
  const citations = await readTaskCitations(database, taskId);
  const passages = citations.map(({ quote, at, page, source }) => ({
    quote,
    ...(at === undefined ? {} : { at }),
    ...(page === undefined ? {} : { page }),
    source,
  }));

  return { kind: "graded", grade: { ...grade, outcome }, passages };
}

/**
 * A passage the graded task was written from, as a learner sees it: the words,
 * and the title and link of where they are from (docs/adr/0021-citations.md).
 */
export type Passage = {
  quote: string;
  /**
   * The second of the recording the words are said at, when the source is a
   * timed transcript — a video's — so the learner can be taken to that moment.
   */
  at?: number;
  /** The label of the page the words are on, when the source is a paged document — a book's. */
  page?: string;
  source: { title: string; url?: string };
};

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
  | { kind: "graded"; grade: Grade; passages: Passage[] };
