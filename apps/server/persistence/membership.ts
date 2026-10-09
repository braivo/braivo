// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { member, organization, organizationDomain, user } from "@braivo/db/schema";
import { and, asc, eq } from "drizzle-orm";

/** An organization as the people who manage it find it: by name and slug. */
export type Organization = { id: string; name: string; slug: string };

/** An organization as listed, with its learn domain: `null` until one is registered (white-label-2). */
export type ListedOrganization = Organization & { learnDomain: string | null };

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

  return row ? splitRoles(row.role) : [];
}

/** Every organization this user is in, with their roles there, by name. */
export async function readMemberships(
  database: Database,
  userId: string,
): Promise<{ organization: ListedOrganization; roles: string[] }[]> {
  const rows = await database
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      learnDomain: organizationDomain.hostname,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    // At most one per organization (its unique index), so no row is repeated.
    .leftJoin(organizationDomain, eq(organizationDomain.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name), asc(organization.id));

  return rows.map(({ role, ...organization }) => ({ organization, roles: splitRoles(role) }));
}

/** A member as the people who manage the organization see them: no email. */
export type Member = { userId: string; name: string; roles: string[] };

/** Every member of this organization, whatever their role, by name. */
export async function readMembers(database: Database, organizationId: string): Promise<Member[]> {
  const rows = await database
    .select({ userId: member.userId, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(user.name), asc(member.userId));

  return rows.map(({ role, ...person }) => ({ ...person, roles: splitRoles(role) }));
}

function splitRoles(role: string): string[] {
  return role.split(",").map((each) => each.trim());
}

/**
 * Deletes an organization made a moment ago, before anything but its members
 * refers to it (they go with it): self-serve setup's undo (ADR 0018).
 */
export async function deleteNewOrganization(database: Database, id: string): Promise<void> {
  await database.delete(organization).where(eq(organization.id, id));
}
