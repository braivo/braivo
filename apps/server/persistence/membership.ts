// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { member } from "@braivo/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * This user's roles in this organization, or none when they are not a member of
 * it. Better Auth stores several roles as one comma-separated string; they are
 * split here so that no caller compares that string whole and refuses a
 * `member,admin`.
 *
 * Roles rather than a yes or no, because membership answers two different
 * questions and they have different answers: whether a learner may be shown an
 * organization's material, and whether someone may act on it. Better Auth's
 * organization plugin writes `owner` for whoever created the organization, and
 * `admin` or `member` for everyone since.
 *
 * Organization membership is the only entitlement Braivo has, and
 * docs/adr/0006-better-auth.md is explicit that carrying an organization ID
 * around is not the same as being allowed into it. This query turns the one
 * into the other, so that a workflow can ask before it reads or writes.
 */
export async function readOrganizationRoles(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<string[]> {
  const [row] = await database
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, input.organizationId), eq(member.userId, input.userId)))
    .limit(1);

  return row?.role.split(",").map((role) => role.trim()) ?? [];
}
