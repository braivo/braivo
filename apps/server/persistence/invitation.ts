// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { invitation, organization, user } from "@braivo/db/schema";
import { and, desc, eq, gt } from "drizzle-orm";

/**
 * An invitation as its page needs it (ADR 0018): whom it is for, as what, its
 * state as stored, its organization, and who sent it. Better Auth writes the
 * rows; Braivo only reads them here.
 */
type StoredInvitation = {
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  organization: { name: string; slug: string };
  inviter: { name: string };
};

export async function readInvitation(
  database: Database,
  invitationId: string,
): Promise<StoredInvitation | undefined> {
  const [row] = await database
    .select({
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, invitationId));
  if (!row) return undefined;

  const { organizationName, organizationSlug, inviterName, role, ...rest } = row;
  return {
    ...rest,
    role: role ?? "member",
    organization: { name: organizationName, slug: organizationSlug },
    inviter: { name: inviterName },
  };
}

/** An invitation waiting to be accepted, as its organization's administrators list it. */
export type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  inviter: { name: string };
  expiresAt: Date;
};

/** An organization's invitations still pending and unexpired at `now`, newest first. */
export async function readPendingInvitations(
  database: Database,
  input: { organizationId: string; now: Date },
): Promise<PendingInvitation[]> {
  const rows = await database
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      inviterName: user.name,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(
      and(
        eq(invitation.organizationId, input.organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, input.now),
      ),
    )
    .orderBy(desc(invitation.createdAt), desc(invitation.id));

  return rows.map(({ inviterName, role, ...rest }) => ({
    ...rest,
    role: role ?? "member",
    inviter: { name: inviterName },
  }));
}
