// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  deleteMember,
  makeMemberOwner,
  type Member,
  type Organization,
  readOrganizationBySlug,
  readOrganizationRoles,
  readUserIdByEmail,
  updateMemberRole,
} from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/**
 * The roles an administrator gives a member: one of them expresses every set
 * of roles but an owner's, since roles add up (access-23, ADR 0048).
 */
const ASSIGNABLE_ROLES: ReadonlySet<string> = new Set(["member", "author", "admin"]);

/**
 * Why a member was not removed or their role not changed: `code` for a client
 * to word it in its language (ADR 0035), `message` the same in English.
 */
export class MemberRefused extends Error {
  constructor(
    readonly code:
      | "ROLE_NOT_ASSIGNABLE"
      | "MEMBER_NOT_FOUND"
      | "MEMBER_IS_OWNER"
      | "OWN_MEMBERSHIP",
    message: string,
  ) {
    super(message);
    this.name = "MemberRefused";
  }
}

/**
 * Refuses an administrator acting on their own membership: one click would
 * lock them out of what they manage. Someone else, or the operator, does it.
 */
function assertNotSelf(actingAs: string, userId: string) {
  if (actingAs === userId) {
    throw new MemberRefused(
      "OWN_MEMBERSHIP",
      "Ask another administrator to change your own membership.",
    );
  }
}

function refusal(found: "owner" | "not a member"): MemberRefused {
  return found === "owner"
    ? new MemberRefused("MEMBER_IS_OWNER", "An owner's membership is not changed here.")
    : new MemberRefused("MEMBER_NOT_FOUND", "No such member.");
}

/**
 * Removes a member from an organization, for whoever administers it, never an
 * owner: they leave its groups, and their learning history stays theirs (ADR
 * 0032). Their open learner sessions are not ended (ADR 0018), but every
 * learner route checks membership, so they reach nothing there.
 */
export async function removeMember(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  userId: string;
}): Promise<void> {
  const { database, organizationId, actingAs, userId } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  assertNotSelf(actingAs, userId);
  const removed = await deleteMember(database, { organizationId, userId });
  if (removed !== "removed") throw refusal(removed);
}

/**
 * Gives a member exactly one role, `member` (a learner), `author`, or
 * `admin`, for whoever administers the organization; never to or from an
 * owner. Answers the member as they then stand.
 */
export async function setMemberRole(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  userId: string;
  role: unknown;
}): Promise<Member> {
  const { database, organizationId, actingAs, userId, role } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  if (typeof role !== "string" || !ASSIGNABLE_ROLES.has(role)) {
    throw new MemberRefused("ROLE_NOT_ASSIGNABLE", "Give a learner, author, or admin role.");
  }
  assertNotSelf(actingAs, userId);
  const set = await updateMemberRole(database, {
    organizationId,
    userId,
    role: role as "member" | "author" | "admin",
  });
  if (typeof set === "string") throw refusal(set);
  return set;
}

export type OwnerPromotionTarget = {
  organization: Organization;
  userId: string;
  email: string;
  roles: string[];
};

/**
 * Who the operator's `make-owner` would promote, for them to confirm (access-58),
 * refusing whatever could not be: promoting comes after, by these IDs, so a
 * confirmation never lands on an account made since under the address.
 */
export async function previewOwnerPromotion(input: {
  database: Database;
  slug: string;
  email: string;
}): Promise<OwnerPromotionTarget> {
  const { database, slug } = input;
  // As sign-in stores it (access-1).
  const email = input.email.trim().toLowerCase();
  if (email === "") throw new Error("An email address is required.");
  const organization = await readOrganizationBySlug(database, slug);
  if (!organization) throw new Error(`No organization has the slug ${slug}.`);
  const userId = await readUserIdByEmail(database, email);
  if (userId === undefined) throw new Error(`No account has the email ${email}.`);
  const roles = await readOrganizationRoles(database, { organizationId: organization.id, userId });
  if (roles.length === 0) {
    throw new Error(`${email} is not a member of ${organization.name}; add them first.`);
  }
  return { organization, userId, email, roles };
}

/** Promotes who `previewOwnerPromotion` found; refused if they left since. */
export async function promoteToOwner(input: {
  database: Database;
  target: OwnerPromotionTarget;
}): Promise<"made" | "already owner"> {
  const { database, target } = input;
  const { organization, userId, email } = target;
  const outcome = await makeMemberOwner(database, { organizationId: organization.id, userId });
  if (outcome === "not a member") {
    throw new Error(
      `${email} is not a member of ${organization.name} any more. Nothing was changed.`,
    );
  }
  return outcome;
}
