// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import {
  attempt,
  course,
  courseObjective,
  learnerEvidence,
  member,
  objective,
  task,
} from "@braivo/db/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

/** A course's tasks, or an objective's, its retired ones included. */
export type FirstAnswersScope = { courseId: string } | { objectiveId: string };

/** A published task in scope: unretired, or, for an objective, retired too. */
type PublishedTaskRow = {
  id: string;
  objectiveId: string;
  body: unknown;
  retiredAt: Date | null;
};

/** One learner's first attempt at one task, classified, never their typed text. */
export type FirstAttempt = {
  taskId: string;
  learnerId: string;
  /** The option chosen, by its authored index, or `null` for a typed answer or a reveal. */
  choice: number | null;
  revealed: boolean;
  outcome: "success" | "failure";
};

/**
 * The organization's published tasks in `scope` and each current member's
 * first attempt at each, its outcome as recorded, never regraded (ADR 0015);
 * `undefined` when the organization has no such course or objective. One
 * snapshot, so the tasks and the attempts agree. A course's tasks are unretired; an
 * objective's include those retired after publishing. Oldest first.
 */
export async function readFirstAttempts(
  database: Database,
  input: { organizationId: string; scope: FirstAnswersScope },
): Promise<{ tasks: PublishedTaskRow[]; attempts: FirstAttempt[] } | undefined> {
  const { organizationId, scope } = input;
  return database.transaction(
    async (transaction) => {
      const found = await ("courseId" in scope
        ? transaction
            .select({ id: course.id })
            .from(course)
            .where(
              and(
                eq(course.organizationId, organizationId),
                eq(course.id, scope.courseId),
                isNull(course.deletedAt),
              ),
            )
        : transaction
            .select({ id: objective.id })
            .from(objective)
            .where(
              and(
                eq(objective.organizationId, organizationId),
                eq(objective.id, scope.objectiveId),
              ),
            ));
      if (found.length === 0) return undefined;

      const tasks = await transaction
        .select({
          id: task.id,
          objectiveId: task.objectiveId,
          body: task.body,
          retiredAt: task.retiredAt,
        })
        .from(task)
        .where(
          and(
            eq(task.organizationId, organizationId),
            // Only a published task was ever asked (ADR 0039).
            isNotNull(task.publishedAt),
            "courseId" in scope
              ? and(
                  isNull(task.retiredAt),
                  inArray(
                    task.objectiveId,
                    transaction
                      .select({ id: courseObjective.objectiveId })
                      .from(courseObjective)
                      .where(
                        and(
                          eq(courseObjective.organizationId, organizationId),
                          eq(courseObjective.courseId, scope.courseId),
                        ),
                      ),
                  ),
                )
              : eq(task.objectiveId, scope.objectiveId),
          ),
        )
        .orderBy(asc(task.createdAt), asc(task.id));
      if (tasks.length === 0) return { tasks, attempts: [] };

      // Each learner's first attempt at each task: ties at one moment by
      // attempt ID, so the choice is stable. Membership as `readMembersEvidence`
      // joins it: a removed member's attempts drop out, a rejoined one's return.
      const first = transaction
        .selectDistinctOn([attempt.taskId, attempt.learnerId], {
          taskId: attempt.taskId,
          learnerId: attempt.learnerId,
          attemptId: attempt.id,
          response: attempt.response,
        })
        .from(attempt)
        .innerJoin(
          member,
          and(
            eq(member.organizationId, attempt.organizationId),
            eq(member.userId, attempt.learnerId),
          ),
        )
        .where(
          and(
            eq(attempt.organizationId, organizationId),
            inArray(
              attempt.taskId,
              tasks.map(({ id }) => id),
            ),
          ),
        )
        .orderBy(attempt.taskId, attempt.learnerId, attempt.at, attempt.id)
        .as("first");

      const attempts = await transaction
        .select({
          taskId: first.taskId,
          learnerId: first.learnerId,
          choice: sql<number | null>`(${first.response} ->> 'choice')::int`,
          revealed: sql<boolean>`(${first.response} ->> 'reveal') is not null`,
          outcome: learnerEvidence.outcome,
        })
        .from(first)
        .innerJoin(task, and(eq(task.organizationId, organizationId), eq(task.id, first.taskId)))
        // Its outcome, by the evidence ID `submitAttempt` writes (ADR 0015):
        // attempt IDs are unique per learner and organization alone, so all three match.
        .innerJoin(
          learnerEvidence,
          and(
            eq(learnerEvidence.learnerId, first.learnerId),
            eq(learnerEvidence.organizationId, organizationId),
            eq(
              learnerEvidence.id,
              sql`'attempt:' || ${first.attemptId} || ':' || ${task.objectiveId}`,
            ),
          ),
        );
      return { tasks, attempts };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
