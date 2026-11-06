// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { type Citation, publishCitations } from "./citation.ts";
import { publishCourses } from "./course.ts";
import { publishTasks } from "./task.ts";

/**
 * Publishes the organization's courses, tasks, and objectives' citations a
 * person reviewed, together or not at all
 * (docs/adr/0039-published-in-the-console.md): `false`, and nothing written,
 * when one is not there to publish. Courses, then tasks, then citations, in
 * every call, so two overlapping ones lock in the same order.
 */
export async function markPublished(
  database: Database,
  input: {
    organizationId: string;
    courseIds: readonly string[];
    taskIds: readonly string[];
    citations?: readonly Citation[];
    now: Date;
  },
): Promise<boolean> {
  const { organizationId, courseIds, taskIds, citations = [], now } = input;
  try {
    await database.transaction(async (transaction) => {
      const published =
        (await publishCourses(transaction, { organizationId, courseIds, now })) &&
        (await publishTasks(transaction, { organizationId, taskIds, now })) &&
        (await publishCitations(transaction, { organizationId, citations, now }));
      // Thrown, so the courses go back too: published without its tasks is not what was reviewed.
      if (!published) throw new NothingPublished();
    });
    return true;
  } catch (error) {
    if (error instanceof NothingPublished) return false;
    throw error;
  }
}

class NothingPublished extends Error {}
