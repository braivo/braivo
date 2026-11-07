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
  hasReviewPassage,
  type LearnerPassage,
  readCourseOrganization,
  readCourseTask,
  readNextTask,
  readObjective,
  type Objective,
  HistoryErased,
  withLearnerHistoryLock,
  readObjectivesWithTasks,
  readTaskCitations,
  recordAttempt,
  RestingTask,
  RetiredTask,
} from "../persistence/index.ts";
import { hostAdmits, type RequestHost } from "./host.ts";
import { loadLearnerInCourse } from "./learner-in-course.ts";
import { isMember } from "./permission.ts";
import { decidePractice, type Practice } from "./practice.ts";
import { restingUntil, TASK_REST_ATTEMPTS, TASK_REST_MS } from "./rest.ts";

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
 * Which objectives it selects among, and in what order, is `decidePractice`'s:
 * those with a task first, filtered
 * before `learning` is called (docs/specs/learning-model.md), so one without
 * never holds up those with one; it is decided, as no activity, only when none
 * of those needs attention or rests. Whether one made acquiring by outside evidence should
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
  /**
   * The objective the learner chose, decided among alone; one outside the
   * course is `unavailable` (docs/adr/0058-learner-chosen-objective.md).
   */
  objectiveId?: string;
}): Promise<NextActivity> {
  const { database, learnerId, courseId, host, now, timeZone, objectiveId: chosen } = input;

  const learner = await loadLearnerInCourse(database, {
    courseId,
    learnerId,
    host,
    now,
    // The learner themselves: only an open course.
    authorize: ({ open }) => open,
  });
  if (learner === undefined) return { kind: "unavailable" };
  if (chosen !== undefined && !learner.objectiveIds.includes(chosen)) {
    return { kind: "unavailable" };
  }
  const scope =
    chosen === undefined ? learner : { ...learner, objectiveIds: [chosen] as readonly string[] };

  const withTasks = await readObjectivesWithTasks(database, scope.objectiveIds);

  // A chosen objective that needs no attention is still served, as extra
  // practice: the learner's request, never the model's (ADR 0058).
  const extraDecision = (objectiveId: string): ActivityDecision => ({
    objectiveId,
    modelVersion: activeModel.version,
    intent: "practise",
  });
  const decide = (): Practice | { kind: "no-activity"; decision: ActivityDecision } => {
    const practice = decidePractice(scope, withTasks, { now, timeZone });
    if (chosen === undefined || practice.kind !== "caught-up") return practice;
    return withTasks.has(chosen)
      ? { kind: "eligible", candidates: [chosen] }
      : { kind: "no-activity", decision: extraDecision(chosen) };
  };

  const practice = decide();
  if (practice.kind !== "eligible") return await asActivity(practice);

  // While every task of the decided objective rests, select again without it,
  // so a learner practises something else, unseen objectives included
  // (docs/adr/0017-task-rest.md). `acquiring` outranks the rest, so it comes
  // back first once its rest ends.
  const select = (candidates: readonly string[]): ActivityDecision | undefined =>
    selectNext({ now, candidates, estimates: learner.estimates, model: activeModel }) ??
    (chosen !== undefined && candidates.includes(chosen) ? extraDecision(chosen) : undefined);
  let candidates = practice.candidates;
  let resting: { objective: Objective; retryAt: Date } | undefined;
  for (let decision = select(candidates); decision !== undefined; decision = select(candidates)) {
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
      candidates = candidates.filter((id) => id !== objectiveId);
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
        historyEpoch: learner.epoch,
        task: { id: task.id, ...presentTask(task.body, seed) },
      };
    }

    if (resting === undefined || retryAt < resting.retryAt) resting = { objective, retryAt };
    candidates = candidates.filter((id) => id !== objectiveId);
  }
  if (resting !== undefined) {
    // The resting screen offers a review of it (ADR 0054); its tasks still rest.
    const reviewable = await hasReviewPassage(database, resting.objective.id);
    return { kind: "resting", ...resting, reviewable };
  }

  // Every objective selected lost its last task meanwhile: decided again as if
  // they never had one, the same order without them (a resting one keeps its
  // task, but none rests here).
  const redecided = decide();
  // Unreachable: the loop ended because nothing with a task left needs attention.
  if (redecided.kind === "eligible") throw new Error("Practice without a task to offer");
  return await asActivity(redecided);

  async function asActivity(
    state: Exclude<ReturnType<typeof decide>, { kind: "eligible" }>,
  ): Promise<NextActivity> {
    if (state.kind !== "no-activity") return state;
    const { decision } = state;
    const objective = await readObjective(database, decision.objectiveId);
    if (objective === undefined) throw new Error(`Objective ${decision.objectiveId} is missing`);
    return { kind: "no-activity", decision, objective };
  }
}

/**
 * Why an activity's objective comes next: the model's decision, or `practise`,
 * the learner's own choice of one needing no attention (extra practice,
 * docs/adr/0058-learner-chosen-objective.md). The application's, so `learning`
 * keeps its three intents.
 */
export type ActivityDecision =
  | LearningDecision
  | { objectiveId: string; modelVersion: string; intent: "practise" };

/**
 * As `NextObjective`, with the task to answer. `no-activity`: the decided
 * objective has no task (glossary: No activity). `resting`: every objective
 * with a task that needs attention has only resting tasks, ahead of any without
 * one, and `objective`'s rest is the first to end, at `retryAt`; the decision is left out, as it may no longer hold by
 * then; `reviewable`, whether reviewing it would show a passage. These three
 * name the objective, so a learner sees what they practise, or what holds them
 * up, not only why. `daily-limit`: nothing else needs
 * attention, and objectives not started yet wait for tomorrow
 * (`limitNewObjectives`).
 */
export type NextActivity =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "caught-up" }
  | { kind: "daily-limit"; limit: number }
  | { kind: "no-activity"; decision: ActivityDecision; objective: Objective }
  | { kind: "resting"; objective: Objective; retryAt: Date; reviewable: boolean }
  | {
      kind: "decided";
      decision: ActivityDecision;
      objective: Objective;
      /** What an answer to `task` sends back (`submitAttempt`). */
      historyEpoch: number;
      task: { id: string } & PresentedTask;
    };

/**
 * The loop's second half: grades a learner's answer and records the attempt
 * with its evidence. The learner submits for themselves, which posting evidence
 * does not allow, because Braivo grades: they choose the answer, never the
 * outcome. A retry under the same `attemptId` stores nothing twice and answers
 * the outcome recorded (`recordAttempt`), with feedback rebuilt from the task.
 *
 * Everything an erasure could change is read under the lock it takes
 * (`withLearnerHistoryLock`): membership, the course still open, and the epoch, so
 * an attempt either lands before an erasure, and is erased, or is refused after
 * it (docs/adr/0053-learners-data.md).
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
  /** The history epoch the activity it answers was read under. */
  historyEpoch: number;
  /** The learner reviewed the objective since their previous attempt on it (ADR 0054). */
  reviewedTeaching: boolean;
  now: Date;
}): Promise<SubmittedAttempt> {
  const { database, learnerId, courseId, host, attemptId, taskId, historyEpoch, now } = input;
  if (attemptId === "" || attemptId.length > MAX_ATTEMPT_ID_LENGTH) return { kind: "invalid" };

  const organizationId = (await readCourseOrganization(database, courseId))?.organizationId;
  if (organizationId === undefined) return { kind: "unavailable" };
  // Outside the transaction: an erasure cannot change it, and it needs no second
  // connection while the lock holds one.
  if (!(await hostAdmits(database, host, organizationId))) return { kind: "unavailable" };

  const answered = await withLearnerHistoryLock(
    database,
    { learnerId, organizationId },
    async (transaction, history) => {
      // Unpublished or hidden, as missing: learners reach only an open course
      // (ADR 0039). An attempt checked before a Hide commits is still recorded.
      const course = await readCourseOrganization(transaction, courseId);
      if (course === undefined || !course.open) return { kind: "unavailable" } as const;
      if (!(await isMember(transaction, { organizationId, userId: learnerId }))) {
        return { kind: "unavailable" } as const;
      }

      const task = await readCourseTask(transaction, { courseId, taskId });
      if (task === undefined) return { kind: "unavailable" } as const;

      const response = parseTaskResponse(task.body, input.response);
      if (response === undefined) return { kind: "invalid" } as const;

      const grade = gradeResponse(task.body, response);
      const outcome = await recordAttempt(transaction, {
        learnerId,
        organizationId,
        attemptId,
        taskId,
        response,
        reviewedTeaching: input.reviewedTeaching,
        at: now,
        // Enforced here too, not only by never offering a resting task: otherwise
        // a client could answer again straight after seeing the answer.
        restWindowStart: new Date(now.getTime() - TASK_REST_MS),
        restAttempts: TASK_REST_ATTEMPTS,
        staleEpoch: historyEpoch !== history.epoch,
        // Built from the attempt so that every attempt is its own evidence
        // (glossary: Evidence ID).
        evidence: {
          id: `${ATTEMPT_EVIDENCE_PREFIX}${attemptId}:${task.objectiveId}`,
          objectiveId: task.objectiveId,
          outcome: grade.outcome,
        },
      });
      return {
        kind: "recorded",
        grade: { ...grade, outcome },
        objectiveId: task.objectiveId,
      } as const;
    },
  ).catch((error: unknown): SubmittedAttempt => {
    if (error instanceof ConflictingAttempt) return { kind: "conflict" };
    if (error instanceof RestingTask) return { kind: "resting" };
    if (error instanceof RetiredTask) return { kind: "unavailable" };
    if (error instanceof HistoryErased) return { kind: "history-erased" };
    throw error;
  });
  if (answered.kind !== "recorded") return answered;

  // Read only now, once graded: shown before answering, a passage could give
  // the answer away. Nothing distinguishes source from learner here, so the
  // learner sees the quote and where it is from, never the source's whole text.
  const [citations, reviewable] = await Promise.all([
    readTaskCitations(database, taskId),
    hasReviewPassage(database, answered.objectiveId),
  ]);
  const passages = citations.map(({ quote, at, page, source }) => ({
    quote,
    ...(at === undefined ? {} : { at }),
    ...(page === undefined ? {} : { page }),
    source,
  }));

  return { kind: "graded", grade: answered.grade, passages, reviewable };
}

/**
 * A passage the graded task, or a reviewed objective, was written from, as a
 * learner sees it: the words, and the title and link of where they are from
 * (docs/adr/0021-citations.md).
 */
export type Passage = LearnerPassage;

/**
 * `unavailable` is a missing course, one the learner is not in, a task outside
 * it, and a new attempt on a retired task, alike, as for `NextObjective`.
 * `invalid` is an attempt ID out of bounds or a response that cannot answer
 * this task; `conflict`, an attempt ID already used otherwise; `resting`, a
 * task this learner answered too recently to answer again yet; `history-erased`,
 * a new attempt under an epoch that is not the learner's current one here.
 */
export type SubmittedAttempt =
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "resting" }
  | { kind: "history-erased" }
  /** `reviewable`: whether reviewing the task's objective would show a passage (ADR 0054). */
  | { kind: "graded"; grade: Grade; passages: Passage[]; reviewable: boolean };
