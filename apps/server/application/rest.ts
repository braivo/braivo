// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  countOtherAttempts,
  readAttemptsAfter,
  readNextTaskAttemptTimes,
} from "../persistence/index.ts";

/**
 * A task rests after Braivo accepts a learner's answer to it, because the grade
 * reveals the answer: for ten minutes, or until three attempts on other
 * objectives, whichever ends first. Provisional (docs/adr/0017-task-rest.md).
 */
export const TASK_REST_MS = 10 * 60_000;
export const TASK_REST_ATTEMPTS = 3;

/**
 * When a task the learner last answered at `lastAttemptAt` may be offered
 * again, or nothing if it already may: after `TASK_REST_MS`, unless
 * `TASK_REST_ATTEMPTS` other objectives' attempts end the rest sooner. Ten
 * minutes is when it ends if nothing else is answered meanwhile.
 */
export async function restingUntil(
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
 * The objectives whose every offered task rests for the learner now, across
 * `organizationIds`: `restingUntil`'s answer for each objective's least recently
 * answered task, as the activity offers it, read in one go for a list of courses.
 *
 * Only an attempt in the last `TASK_REST_MS` can rest anything, so the attempts
 * in that window are all it needs, and most reads stop at finding none.
 */
export async function readRestingObjectives(
  database: Database,
  input: { learnerId: string; organizationIds: readonly string[]; now: Date },
): Promise<ReadonlySet<string>> {
  const { learnerId, organizationIds, now } = input;
  const windowStart = new Date(now.getTime() - TASK_REST_MS);
  const recent = await readAttemptsAfter(database, {
    learnerId,
    organizationIds,
    after: windowStart,
  });
  if (recent.length === 0) return new Set();

  const organizationOf = new Map(recent.map((each) => [each.objectiveId, each.organizationId]));
  const leastRecent = await readNextTaskAttemptTimes(database, {
    learnerId,
    objectiveIds: [...organizationOf.keys()],
  });
  const resting = new Set<string>();
  for (const [objectiveId, lastAttemptAt] of leastRecent) {
    if (lastAttemptAt === undefined || lastAttemptAt <= windowStart) continue;
    const others = recent.filter(
      (each) =>
        each.organizationId === organizationOf.get(objectiveId) &&
        each.objectiveId !== objectiveId &&
        each.at > lastAttemptAt,
    );
    if (others.length < TASK_REST_ATTEMPTS) resting.add(objectiveId);
  }
  return resting;
}
