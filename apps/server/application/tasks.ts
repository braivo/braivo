// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { parseTaskBody, type TaskBody } from "../content/index.ts";
import { createTasks, findObjectivesOutsideOrganization } from "../persistence/index.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/** A task that is not a valid one of its kind, whoever sent it. */
export class InvalidTask extends Error {
  constructor(readonly index: number) {
    super(`The task at index ${index} is not a valid task.`);
    this.name = "InvalidTask";
  }
}

/**
 * Adds tasks to an organization's objectives, returning their generated IDs in
 * the order given. Refuses the whole batch on any invalid task, a caller who may
 * not author, or an objective that is not the organization's.
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
  tasks: readonly { objectiveId: string; body: unknown }[];
  now: Date;
}): Promise<string[]> {
  const { database, organizationId, actingAs, tasks, now } = input;

  const parsed: { objectiveId: string; body: TaskBody }[] = [];
  for (const [index, task] of tasks.entries()) {
    const body = parseTaskBody(task.body);
    if (body === undefined) throw new InvalidTask(index);
    parsed.push({ objectiveId: task.objectiveId, body });
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

  return createTasks(database, organizationId, parsed, now);
}
