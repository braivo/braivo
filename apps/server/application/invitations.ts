// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import * as z from "zod";

import {
  type PendingInvitation,
  readInvitation,
  readMemberRolesByEmail,
  readOrganizationRoles,
  readPendingInvitations,
  readUserEmail,
} from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

export type { PendingInvitation } from "../persistence/index.ts";

/**
 * The roles an invitation may carry (ADR 0018): an author or an administrator.
 * Never `owner`, which only creating an organization gives; not yet `member`,
 * a learner, whose invitation must also check the learn domain.
 */
export type InvitableRole = "author" | "admin";
export const INVITABLE_ROLES: ReadonlySet<string> = new Set<InvitableRole>(["author", "admin"]);

/**
 * Why an invitation was not made: `code` for a client to word it in its
 * language (ADR 0035), `message` the same in English, and what the address
 * already holds there, a member's roles or a pending invitation's role.
 */
export class InvitationRefused extends Error {
  constructor(
    readonly code:
      | "EMAIL_INVALID"
      | "ROLE_NOT_INVITABLE"
      | "ALREADY_MEMBER"
      | "ALREADY_INVITED"
      | "PENDING_LIMIT",
    message: string,
    readonly held: { roles?: string[]; role?: string } = {},
  ) {
    super(message);
    this.name = "InvitationRefused";
  }
}

/** An invitation made, and whether its mail went: Better Auth stores it before sending. */
export type Invited = {
  invitation: { id: string; email: string; role: string; expiresAt: Date };
  emailSent: boolean;
};

/**
 * Better Auth making the invitation as the actor, its hooks run (ADR 0018):
 * the invitation, or what it found in the way.
 */
type CreateInvitation = (invitation: {
  email: string;
  role: InvitableRole;
}) => Promise<Invited | "already a member" | "already invited" | "pending limit">;

/**
 * Invites `email` to an organization as `role`, for whoever administers it.
 * The address is trimmed and lowercased, as Better Auth stores it; one already
 * a member, or already invited, is reported with what they hold, and keeps it.
 */
export async function inviteToOrganization(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  email: string;
  role: unknown;
  create: CreateInvitation;
}): Promise<Invited> {
  const { database, organizationId, actingAs, role, create } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const email = input.email.trim().toLowerCase();
  if (!z.email().safeParse(email).success) {
    throw new InvitationRefused("EMAIL_INVALID", "Enter an email address.");
  }
  if (typeof role !== "string" || !INVITABLE_ROLES.has(role)) {
    throw new InvitationRefused("ROLE_NOT_INVITABLE", "Invite as an author or an admin.");
  }

  // Narrowed by the check above.
  const made = await create({ email, role: role as InvitableRole });
  if (made === "already a member") {
    const roles = await readMemberRolesByEmail(database, { organizationId, email });
    throw new InvitationRefused("ALREADY_MEMBER", `${email} is already a member.`, { roles });
  }
  if (made === "already invited") {
    const pending = await readPendingInvitations(database, { organizationId, now: new Date() });
    const held = pending.find((each) => each.email === email)?.role;
    throw new InvitationRefused("ALREADY_INVITED", `${email} is already invited.`, { role: held });
  }
  if (made === "pending limit") {
    throw new InvitationRefused(
      "PENDING_LIMIT",
      "Too many invitations are waiting; wait for some to be accepted or expire.",
    );
  }
  return made;
}

/** An organization's invitations waiting to be accepted, for whoever administers it. */
export async function listInvitations(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  now: Date;
}): Promise<PendingInvitation[]> {
  const { database, organizationId, actingAs, now } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  return readPendingInvitations(database, { organizationId, now });
}

/**
 * An invitation as its page shows it (ADR 0018). To anyone with the link, the
 * school's name and its state; to the account it was sent to, also the role,
 * the inviter, where it leads, and whether it is a member there already, by
 * this invitation or another way; to another account, only that it is not
 * theirs. Never the email it was sent to.
 */
export type InvitationPage = {
  organization: { name: string; slug?: string };
  status: "pending" | "expired" | "canceled" | "accepted";
  recipient?: boolean;
  member?: boolean;
  role?: string;
  inviter?: { name: string };
};

export async function readInvitationPage(input: {
  database: Database;
  invitationId: string;
  /** The signed-in account, if any. */
  viewer: string | undefined;
  now: Date;
}): Promise<InvitationPage | undefined> {
  const { database, invitationId, viewer, now } = input;
  const found = await readInvitation(database, invitationId);
  if (!found) return undefined;

  const status =
    found.status === "accepted"
      ? "accepted"
      : found.status !== "pending"
        ? "canceled"
        : found.expiresAt <= now
          ? "expired"
          : "pending";
  const page: InvitationPage = { organization: { name: found.organization.name }, status };
  if (viewer === undefined) return page;

  const email = await readUserEmail(database, viewer);
  const recipient = email?.toLowerCase() === found.email.toLowerCase();
  if (!recipient) return { ...page, recipient };
  const roles = await readOrganizationRoles(database, {
    organizationId: found.organizationId,
    userId: viewer,
  });
  return {
    organization: found.organization,
    status,
    recipient,
    member: roles.length > 0,
    role: found.role,
    inviter: found.inviter,
  };
}
