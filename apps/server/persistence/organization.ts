// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { course, objective } from "@braivo/db/schema";
import { eq } from "drizzle-orm";

/**
 * Whether anything of the learning model still belongs to this organization.
 *
 * `objective` and `course` both reference `organization` with `on delete
 * restrict`, so this answers exactly one question: would deleting the
 * organization be refused by the database. Both tables are checked because
 * either alone is enough to refuse — a course may exist before it has any
 * objectives — and because an objective is what a learner's recorded evidence
 * hangs from, which is the history the restriction exists to protect.
 *
 * Two queries rather than one, each served by the organization index. Deletion
 * is not a hot path, and a single statement asking the same thing would need
 * raw SQL to express.
 */
export async function organizationOwnsLearningContent(
  database: Database,
  organizationId: string,
): Promise<boolean> {
  const [objectives, courses] = await Promise.all([
    database
      .select({ id: objective.id })
      .from(objective)
      .where(eq(objective.organizationId, organizationId))
      .limit(1),
    database
      .select({ id: course.id })
      .from(course)
      .where(eq(course.organizationId, organizationId))
      .limit(1),
  ]);

  return objectives.length > 0 || courses.length > 0;
}
