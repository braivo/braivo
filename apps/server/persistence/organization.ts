// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { course, file, objective, organization, source } from "@braivo/db/schema";
import { eq } from "drizzle-orm";

/**
 * Whether anything of the learning model still belongs to this organization.
 *
 * `objective`, `course`, `source`, and `file` all reference `organization`
 * with `on delete restrict`, so this answers exactly one question: would
 * deleting the organization be refused by the database. Each table is checked
 * because any one is enough to refuse: a course may exist before it has
 * objectives, a source before anything cites it, a file before a source names
 * it. The restriction protects learners' history, which hangs from objectives.
 * `ai_request` cascades, so it is not checked.
 *
 * One query per table, each served by the organization index: deletion is not
 * a hot path, and one statement would need raw SQL.
 */
export async function organizationOwnsLearningContent(
  database: Database,
  organizationId: string,
): Promise<boolean> {
  const found = await Promise.all(
    [objective, course, source, file].map((table) =>
      database
        .select({ organizationId: table.organizationId })
        .from(table)
        .where(eq(table.organizationId, organizationId))
        .limit(1),
    ),
  );

  return found.some((rows) => rows.length > 0);
}

/** An organization's slug, or `undefined` when there is no such organization. */
export async function readOrganizationSlug(
  database: Database,
  organizationId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, organizationId));

  return row?.slug;
}
