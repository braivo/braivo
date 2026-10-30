// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { course, file, objective, organization, source, user } from "@braivo/db/schema";
import { and, eq, ne } from "drizzle-orm";

import type { Organization } from "./membership.ts";

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

/** An organization by its slug, or `undefined` when no organization has it. */
export async function readOrganizationBySlug(
  database: Database,
  slug: string,
): Promise<Organization | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.slug, slug));

  return row;
}

/**
 * Names an organization `name`, already checked, answering the name stored,
 * or `undefined` when there is no such organization.
 */
export async function updateOrganizationName(
  database: Database,
  input: { organizationId: string; name: string },
): Promise<string | undefined> {
  const [renamed] = await database
    .update(organization)
    .set({ name: input.name })
    .where(eq(organization.id, input.organizationId))
    .returning({ name: organization.name });
  return renamed?.name;
}

/**
 * Whether the organization lets tools read its learners' data (ADR 0050);
 * `false` when there is no such organization.
 */
export async function toolsMayReadLearnerData(
  database: Database,
  organizationId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ allowed: organization.toolsReadLearnerData })
    .from(organization)
    .where(eq(organization.id, organizationId));

  return row?.allowed ?? false;
}

/**
 * Whether tools read the organization's learners' data (ADR 0050); who last
 * changed it, `null` before the first change or once their account is gone;
 * and when, `null` until first changed.
 */
export type ToolsReadLearnerData = {
  allowed: boolean;
  changedBy: { userId: string; name: string } | null;
  changedAt: Date | null;
};

/** The organization's `ToolsReadLearnerData`, or `undefined` when there is no such organization. */
export async function findToolsReadLearnerData(
  database: Database,
  organizationId: string,
): Promise<ToolsReadLearnerData | undefined> {
  const [row] = await database
    .select({
      allowed: organization.toolsReadLearnerData,
      changedAt: organization.toolsReadLearnerDataChangedAt,
      userId: user.id,
      name: user.name,
    })
    .from(organization)
    .leftJoin(user, eq(user.id, organization.toolsReadLearnerDataChangedBy))
    .where(eq(organization.id, organizationId));
  if (!row) return undefined;

  const { allowed, changedAt, userId, name } = row;
  return {
    allowed,
    changedBy: userId === null || name === null ? null : { userId, name },
    changedAt,
  };
}

/**
 * Sets whether tools read the organization's learners' data, recording who and
 * when in the same statement, and only where the value differs: setting the
 * value it has changes nothing, its record included. Row locking serializes
 * concurrent writes and each rechecks the condition, so two turning it on at
 * once record one change; otherwise the last one's word is final.
 */
export async function updateToolsReadLearnerData(
  database: Database,
  input: { organizationId: string; allowed: boolean; changedBy: string; changedAt: Date },
): Promise<void> {
  await database
    .update(organization)
    .set({
      toolsReadLearnerData: input.allowed,
      toolsReadLearnerDataChangedBy: input.changedBy,
      toolsReadLearnerDataChangedAt: input.changedAt,
    })
    .where(
      and(
        eq(organization.id, input.organizationId),
        ne(organization.toolsReadLearnerData, input.allowed),
      ),
    );
}
