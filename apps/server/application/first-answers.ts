// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { TaskBody } from "../content/index.ts";
import {
  type FirstAnswersScope,
  type FirstAttempt,
  readFirstAttempts,
} from "../persistence/index.ts";
import type { AccessKind } from "./access.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/**
 * Below this many distinct learners, counts are withheld. It limits noise, it
 * does not anonymize: an option's count can be one learner, and these readers
 * read each learner's own report already (progress-1).
 */
const MIN_LEARNERS = 5;

/** First answers to one task, each learner's first counted once, in exactly one class. */
type FirstAnswerCounts = {
  learners: number;
  correct: number;
  incorrect: number;
  /** Show answer first. */
  revealed: number;
  /** A choice task's: how many first chose each option, in authored order; reveals excluded. */
  options?: number[];
};

/**
 * The same, over the objective's other published, unretired tasks: one
 * learner's first answer to each, so `responses` may exceed `learners`, the
 * distinct learners across them, which the floor counts.
 */
type OtherTasksCounts = {
  responses: number;
  learners: number;
  correct: number;
  incorrect: number;
  revealed: number;
};

export type FirstAnswersSummary = {
  minLearners: number;
  /** Each published, unretired task in scope, oldest first. */
  tasks: {
    id: string;
    objectiveId: string;
    /** `null` under `minLearners`, none included. */
    first: FirstAnswerCounts | null;
    /** `null` with no other task, or under `minLearners` across them. */
    otherTasks: OtherTasksCounts | null;
  }[];
  /**
   * An objective's published tasks retired since, newest retirement first, as
   * authored: a correction starts with no answers, the task it replaced keeping
   * its own. Empty for a course.
   */
  retired: (TaskBody & {
    id: string;
    objectiveId: string;
    retiredAt: Date;
    first: FirstAnswerCounts | null;
  })[];
};

/**
 * How learners first answered each published task of a course or an
 * objective, for its organization's `owner` or `admin`, in a browser alone, as
 * learners' reports are (ADR 0052): learner-derived, though naming no one. The
 * organization's current members' attempts there, through whichever course,
 * since attempts carry none. `undefined` for a course or objective the
 * organization does not have; the reader is refused before it is looked up.
 */
export async function readFirstAnswers(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
  scope: FirstAnswersScope;
}): Promise<FirstAnswersSummary | undefined> {
  const { database, organizationId, actingAs, accessKind, scope } = input;
  if (accessKind !== "browser") {
    throw new NotPermitted("Only a browser reads learners' first answers.");
  }
  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const read = await readFirstAttempts(database, { organizationId, scope });
  if (read === undefined) return undefined;

  const attemptsOf = Map.groupBy(read.attempts, ({ taskId }) => taskId);
  const live = read.tasks.filter(({ retiredAt }) => retiredAt === null);
  const firstOf = (taskId: string, body: unknown) =>
    countFirst(attemptsOf.get(taskId) ?? [], body as TaskBody);

  return {
    minLearners: MIN_LEARNERS,
    tasks: live.map(({ id, objectiveId, body }) => ({
      id,
      objectiveId,
      first: firstOf(id, body),
      otherTasks: countOtherTasks(
        live
          .filter((other) => other.objectiveId === objectiveId && other.id !== id)
          .flatMap((other) => attemptsOf.get(other.id) ?? []),
      ),
    })),
    retired: read.tasks
      .flatMap(({ retiredAt, ...rest }) => (retiredAt === null ? [] : [{ ...rest, retiredAt }]))
      .sort((a, b) => b.retiredAt.getTime() - a.retiredAt.getTime())
      .map(({ id, objectiveId, body, retiredAt }) => ({
        ...(body as TaskBody),
        id,
        objectiveId,
        retiredAt,
        first: firstOf(id, body),
      })),
  };
}

/** Correct, incorrect, revealed: exclusive, from the recorded outcome. */
function classify(attempts: readonly FirstAttempt[]) {
  const counts = { correct: 0, incorrect: 0, revealed: 0 };
  for (const { revealed, outcome } of attempts) {
    if (revealed) counts.revealed++;
    else if (outcome === "success") counts.correct++;
    else counts.incorrect++;
  }
  return counts;
}

/** `attempts` are firsts already: one per learner. */
function countFirst(attempts: readonly FirstAttempt[], body: TaskBody): FirstAnswerCounts | null {
  if (attempts.length < MIN_LEARNERS) return null;
  const counts: FirstAnswerCounts = { learners: attempts.length, ...classify(attempts) };
  if (body.kind === "choice") {
    counts.options = body.options.map(() => 0);
    for (const { choice, revealed } of attempts) {
      if (!revealed && choice !== null && choice in counts.options) counts.options[choice]!++;
    }
  }
  return counts;
}

function countOtherTasks(attempts: readonly FirstAttempt[]): OtherTasksCounts | null {
  const learners = new Set(attempts.map(({ learnerId }) => learnerId)).size;
  if (learners < MIN_LEARNERS) return null;
  return { responses: attempts.length, learners, ...classify(attempts) };
}
