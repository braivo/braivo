// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import { groupMember, member, organization, organizationDomain, user } from "@braivo/db/schema";
import { and, asc, count, eq, sql } from "drizzle-orm";

import type { LearnerScope } from "./learner-history.ts";

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
 * organization's material, and whether someone may act on it.
 *
 * Organization membership is the only entitlement Braivo has, and
 * docs/adr/0006-better-auth.md is explicit that carrying an organization ID
 * around is not the same as being allowed into it. This query turns the one
 * into the other, so that a workflow can ask before it reads or writes.
 */
export async function readOrganizationRoles(
  database: Database | Transaction,
  input: { organizationId: string; userId: string },
): Promise<string[]> {
  const [row] = await database
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, input.organizationId), eq(member.userId, input.userId)))
    .limit(1);

  return row ? splitRoles(row.role) : [];
}

/** The roles of whoever holds `email` in this organization, none when they are not a member. */
export async function readMemberRolesByEmail(
  database: Database,
  input: { organizationId: string; email: string },
): Promise<string[]> {
  const [row] = await database
    .select({ role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, input.organizationId), eq(user.email, input.email)));

  return row ? splitRoles(row.role) : [];
}

/** The account `email` names, as sign-in stores it: trimmed and lowercased. */
export async function readUserIdByEmail(
  database: Database,
  email: string,
): Promise<string | undefined> {
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
  return row?.id;
}

/** An account's email and name, or `undefined` when there is no such account. */
export async function readUser(
  database: Database,
  userId: string,
): Promise<{ email: string; name: string } | undefined> {
  const [row] = await database
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId));
  return row;
}

/**
 * Every organization this user is in, by name, with their roles there and
 * whether they teach any of its groups (ADR 0042).
 */
export async function readMemberships(
  database: Database,
  userId: string,
): Promise<
  { organization: ListedOrganization & { personal: boolean }; roles: string[]; teaches: boolean }[]
> {
  const rows = await database
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      personal: sql<boolean>`${organization.personalOwnerId} is not null`,
      // The one it is named by, as `readLearnDomain` reads it.
      learnDomain: sql<string | null>`(
        select ${organizationDomain.hostname} from ${organizationDomain}
        where ${organizationDomain.organizationId} = ${organization.id}
        order by ${organizationDomain.registeredAt} desc, ${organizationDomain.hostname} desc
        limit 1
      )`,
      role: member.role,
      teaches: sql<boolean>`exists (
        select 1 from ${groupMember}
        where ${groupMember.organizationId} = ${organization.id}
          and ${groupMember.userId} = ${member.userId}
          and ${groupMember.role} = 'teacher'
      )`,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name), asc(organization.id));

  return rows.map(({ role, teaches, ...organization }) => ({
    organization,
    roles: splitRoles(role),
    teaches,
  }));
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

/** Whether a stored role string, comma-separated, includes `owner`. */
const holdsOwner = sql`'owner' = any(string_to_array(replace(${member.role}, ' ', ''), ','))`;

/**
 * Whether ending this membership would leave the organization with no owner:
 * nobody could then administer it, and only the database could give it another.
 * Its owners' rows stay locked until commit: two owners ending theirs at once
 * hold different learners' locks, so the second must wait here and read again.
 */
export async function isOnlyOwner(
  transaction: Transaction,
  { learnerId, organizationId }: LearnerScope,
): Promise<boolean> {
  const owners = await transaction
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), holdsOwner))
    .orderBy(asc(member.id))
    .for("update");
  return owners.length === 1 && owners[0]?.userId === learnerId;
}

/**
 * Removes a member who holds no `owner`, atomically on that: their groups go
 * with the membership (ADR 0042), their learning history stays, kept per
 * learner (ADR 0032). Answers what was found.
 */
export async function deleteMember(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<"removed" | "owner" | "not a member"> {
  const where = and(
    eq(member.organizationId, input.organizationId),
    eq(member.userId, input.userId),
  );
  const rows = await database
    .delete(member)
    .where(and(where, sql`not ${holdsOwner}`))
    .returning({ id: member.id });
  if (rows.length > 0) return "removed";
  return (await readOrganizationRoles(database, input)).length > 0 ? "owner" : "not a member";
}

/**
 * Sets a member's roles to exactly `role`, where they hold no `owner`,
 * atomically on that, answering them as they then stand.
 */
export async function updateMemberRole(
  database: Database,
  input: { organizationId: string; userId: string; role: "member" | "author" | "admin" },
): Promise<Member | "owner" | "not a member"> {
  const [row] = await database
    .update(member)
    .set({ role: input.role })
    .where(
      and(
        eq(member.organizationId, input.organizationId),
        eq(member.userId, input.userId),
        sql`not ${holdsOwner}`,
      ),
    )
    .returning({ userId: member.userId, role: member.role });
  if (!row) {
    return (await readOrganizationRoles(database, input)).length > 0 ? "owner" : "not a member";
  }
  const [named] = await database
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, row.userId));
  return { userId: row.userId, name: named?.name ?? "", roles: splitRoles(row.role) };
}

/**
 * Makes a member an owner, and nothing else: exactly `owner`, which holds what
 * every other role does, never adding a member or touching another owner. Needs
 * no lock of `isOnlyOwner`'s: it only adds an owner, and whatever waits on this
 * row, a removal or a role change, then finds an owner and refuses.
 */
export async function makeMemberOwner(
  database: Database | Transaction,
  input: { organizationId: string; userId: string },
): Promise<"made" | "already owner" | "not a member"> {
  const where = and(
    eq(member.organizationId, input.organizationId),
    eq(member.userId, input.userId),
  );
  const rows = await database
    .update(member)
    .set({ role: "owner" })
    .where(and(where, sql`not ${holdsOwner}`))
    .returning({ id: member.id });
  if (rows.length > 0) return "made";
  const [held] = await database.select({ id: member.id }).from(member).where(where);
  return held ? "already owner" : "not a member";
}

function splitRoles(role: string): string[] {
  return role.split(",").map((each) => each.trim());
}

/**
 * The account's personal organization (ADR 0060): the one whose
 * `personal_owner_id` it is, or, having none, `create()`'s, with the account
 * its `owner`, organization and membership in one transaction. The unique
 * owner column holds one per account: setups at once insert one, the others
 * meeting it on conflict and answering it. Never through Better Auth, which
 * takes `personal_owner_id` as no input.
 */
export async function ensurePersonalOrganization(
  database: Database,
  input: { ownerId: string; at: Date; create: () => { id: string; name: string; slug: string } },
): Promise<{ organization: Organization; created: boolean }> {
  return database.transaction(async (transaction) => {
    const created = input.create();
    const [inserted] = await transaction
      .insert(organization)
      .values({ ...created, personalOwnerId: input.ownerId, createdAt: input.at })
      .onConflictDoNothing({ target: organization.personalOwnerId })
      .returning({ id: organization.id });
    if (!inserted) {
      // Committed by another setup, which this insert waited for: this
      // statement's snapshot, taken after, sees it.
      const owned = await readPersonalOrganization(transaction, input.ownerId);
      if (!owned) throw new Error("A personal organization conflicted and was not there.");
      return { organization: owned, created: false };
    }
    await transaction.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: created.id,
      userId: input.ownerId,
      role: "owner",
      createdAt: input.at,
    });
    return { organization: created, created: true };
  });
}

/** The account's personal organization, by its owner column alone, never by membership. */
export async function readPersonalOrganization(
  database: Database | Transaction,
  ownerId: string,
): Promise<Organization | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.personalOwnerId, ownerId));
  return row;
}

/** Whether the organization is someone's personal organization (ADR 0060); `false` for none. */
export async function isPersonalOrganization(
  database: Database | Transaction,
  organizationId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ ownerId: organization.personalOwnerId })
    .from(organization)
    .where(eq(organization.id, organizationId));
  return row?.ownerId != null;
}

/**
 * Deletes an organization made a moment ago, before anything but its members
 * refers to it (they go with it): self-serve setup's undo (ADR 0018).
 */
export async function deleteNewOrganization(database: Database, id: string): Promise<void> {
  await database.delete(organization).where(eq(organization.id, id));
}

/** How many members an organization has, staff included. */
export async function countMembers(database: Database, organizationId: string): Promise<number> {
  const [row] = await database
    .select({ count: count() })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return row?.count ?? 0;
}
