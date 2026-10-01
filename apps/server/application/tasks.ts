// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { parseTaskBody, type TaskBody } from "../content/index.ts";
import {
  type AuthoredTask,
  createTasks,
  findObjectivesOutsideOrganization,
  findTasksOutsideOrganization,
  markTasksRetired,
  readObjectiveTasks,
} from "../persistence/index.ts";
import { locateCitations } from "./citations.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/**
 * A task that is not a valid one of its kind, whoever sent it, named by its
 * position in the batch and saying what is wrong: "Task 1 repeats option 0 as
 * option 2; every option must differ."
 */
export class InvalidTask extends Error {
  constructor(
    readonly index: number,
    problem: string,
  ) {
    super(`Task ${index} ${problem}.`);
    this.name = "InvalidTask";
  }
}

/**
 * Adds tasks to an organization's objectives, returning their IDs in the order
 * given; a task the objective already has returns its existing ID
 * (docs/adr/0024-idempotent-authoring.md). Refuses the whole batch on any
 * invalid task, a caller who may not author, or an objective that is not the
 * organization's.
 *
 * Bodies are checked first, reading only the payload, so a refused caller
 * learns nothing about the organization. A task is immutable once stored, so
 * this is the only chance to catch a broken answer key (docs/adr/0015-tasks.md).
 */
export async function defineTasks(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  /**
   * Each task's `citations` are the passages it was written from, located as
   * an objective's are (ADR 0021) and stored with the task or not at all. A
   * task written by hand may have none.
   */
  tasks: readonly {
    objectiveId: string;
    body: unknown;
    citations?: readonly { sourceId: string; quote: string }[];
  }[];
  now: Date;
}): Promise<string[]> {
  const { database, organizationId, actingAs, tasks, now } = input;

  const parsed: { objectiveId: string; body: TaskBody }[] = [];
  for (const [index, task] of tasks.entries()) {
    const read = parseTaskBody(task.body);
    if ("problem" in read) throw new InvalidTask(index, read.problem);
    parsed.push({ objectiveId: task.objectiveId, body: read.body });
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const outside = await findObjectivesOutsideOrganization(
    database,
    organizationId,
    parsed.map((task) => task.objectiveId),
  );
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  // Located in one pass over the whole batch, so each source's text is read once.
  const quotes = tasks.flatMap(({ citations = [] }, taskIndex) =>
    citations.map(({ sourceId, quote }, index) => ({
      sourceId,
      quote,
      where: `Task ${taskIndex}, citation ${index}`,
    })),
  );
  const located = await locateCitations(database, organizationId, quotes);

  let next = 0;
  const grounded = parsed.map((task, index) => {
    const count = tasks[index]!.citations?.length ?? 0;
    const citations = located.slice(next, next + count);
    next += count;
    return { ...task, citations };
  });

  return createTasks(database, organizationId, grounded, now);
}

/**
 * Withdraws tasks from practice (docs/adr/0015-tasks.md). Refuses the whole
 * batch when the caller may not administer or a task is not the organization's.
 */
export async function retireTasks(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  taskIds: readonly string[];
  now: Date;
}): Promise<void> {
  const { database, organizationId, actingAs, taskIds, now } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  // Checked apart from the write: a task never changes organization.
  const outside = await findTasksOutsideOrganization(database, organizationId, taskIds);
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  await markTasksRetired(database, taskIds, now);
}

/**
 * An objective's unretired tasks as authored, answers included, with the
 * passages each cites, for whoever administers its organization; or
 * `undefined` when the organization has no such objective. A task is changed
 * only by retiring it and writing another, so this is what review starts from.
 */
export async function listObjectiveTasks(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  objectiveId: string;
}): Promise<AuthoredTask[] | undefined> {
  const { database, organizationId, actingAs, objectiveId } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const [outside] = await findObjectivesOutsideOrganization(database, organizationId, [
    objectiveId,
  ]);
  if (outside !== undefined) return undefined;

  return readObjectiveTasks(database, objectiveId);
}
