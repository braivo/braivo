// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { invitation, invitationMailClaim, organization, user } from "@braivo/db/schema";
import { and, count, desc, eq, gt, inArray, lte, max, sql } from "drizzle-orm";

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

/** An organization's invitations waiting at `now`: pending and unexpired, as Better Auth leaves an expired one pending. */
const waitingIn = (organizationId: string, now: Date) =>
  and(
    eq(invitation.organizationId, organizationId),
    eq(invitation.status, "pending"),
    gt(invitation.expiresAt, now),
  );

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
    .where(waitingIn(input.organizationId, input.now))
    .orderBy(desc(invitation.createdAt), desc(invitation.id));

  return rows.map(({ inviterName, role, ...rest }) => ({
    ...rest,
    role: role ?? "member",
    inviter: { name: inviterName },
  }));
}

/** How many of an organization's invitations are pending and unexpired at `now`. */
export async function countPendingInvitations(
  database: Database,
  input: { organizationId: string; now: Date },
): Promise<number> {
  const [row] = await database
    .select({ count: count() })
    .from(invitation)
    .where(waitingIn(input.organizationId, input.now));
  return row?.count ?? 0;
}

/** The role of `email`'s invitation to this organization pending and unexpired at `now`, if any. */
export async function readPendingInvitationRole(
  database: Database,
  input: { organizationId: string; email: string; now: Date },
): Promise<string | undefined> {
  const [row] = await database
    .select({ role: invitation.role })
    .from(invitation)
    .where(and(waitingIn(input.organizationId, input.now), eq(invitation.email, input.email)))
    .orderBy(desc(invitation.createdAt))
    .limit(1);
  return row ? (row.role ?? "member") : undefined;
}

/** An invitation of this organization as Resend needs it, or `undefined` for none there. */
export async function readOrganizationInvitation(
  database: Database,
  input: { organizationId: string; invitationId: string },
): Promise<
  { id: string; email: string; role: string; status: string; expiresAt: Date } | undefined
> {
  const [row] = await database
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.id, input.invitationId),
        eq(invitation.organizationId, input.organizationId),
      ),
    );
  return row && { ...row, role: row.role ?? "member" };
}

/**
 * Renews an invitation's expiry, only while it is still pending and unexpired
 * at `now`, atomically on both: answers it renewed, or `undefined` when
 * acceptance, a cancel, or its expiry came first.
 */
export async function renewInvitation(
  database: Database,
  input: { invitationId: string; now: Date; expiresAt: Date },
): Promise<{ id: string; email: string; role: string; expiresAt: Date } | undefined> {
  const [row] = await database
    .update(invitation)
    .set({ expiresAt: input.expiresAt })
    .where(
      and(
        eq(invitation.id, input.invitationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, input.now),
      ),
    )
    .returning({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    });
  return row && { ...row, role: row.role ?? "member" };
}

/** The mail bounds (ADR 0018), as numbers. */
export type MailBounds = {
  perAddressPerDay: number;
  cooldownSeconds: number;
  perOrganizationPerHour: number;
};

/** Which mail bound refused a mail. */
export type MailBoundCode =
  | "RECIPIENT_DAILY_LIMIT"
  | "RECIPIENT_COOLDOWN"
  | "ORGANIZATION_HOURLY_LIMIT";

/**
 * Counts one invitation mail to `email` from an organization against the
 * bounds, answering the claim's ID to release if no mail is then tried, or
 * the bound it would pass, counting nothing. One transaction under the
 * organization's lock, then the address's, always in that order, so claims
 * at once can neither pass a bound nor wait on each other in a cycle.
 */
export async function claimInvitationMail(
  database: Database,
  input: { email: string; organizationId: string; now: Date; bounds: MailBounds },
): Promise<{ claimId: number } | { refused: MailBoundCode }> {
  const { email, organizationId, now, bounds } = input;
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const lock = (key: string) =>
    sql`select pg_advisory_xact_lock(hashtextextended(${`braivo:invitation-mail:${key}`}, 0))`;
  return database.transaction(async (transaction) => {
    await transaction.execute(lock(`organization:${organizationId}`));
    await transaction.execute(lock(`email:${email}`));

    const [address] = await transaction
      .select({ count: count(), last: max(invitationMailClaim.claimedAt) })
      .from(invitationMailClaim)
      .where(
        and(eq(invitationMailClaim.email, email), gt(invitationMailClaim.claimedAt, ago(86_400))),
      );
    if ((address?.count ?? 0) >= bounds.perAddressPerDay) {
      return { refused: "RECIPIENT_DAILY_LIMIT" as const };
    }
    if (address?.last && address.last > ago(bounds.cooldownSeconds)) {
      return { refused: "RECIPIENT_COOLDOWN" as const };
    }
    const [sent] = await transaction
      .select({ count: count() })
      .from(invitationMailClaim)
      .where(
        and(
          eq(invitationMailClaim.organizationId, organizationId),
          gt(invitationMailClaim.claimedAt, ago(3_600)),
        ),
      );
    if ((sent?.count ?? 0) >= bounds.perOrganizationPerHour) {
      return { refused: "ORGANIZATION_HOURLY_LIMIT" as const };
    }

    // Rows past a day count nothing: a few go with each claim, skipping any
    // another claim is deleting, so two never wait on each other.
    const stale = transaction
      .select({ id: invitationMailClaim.id })
      .from(invitationMailClaim)
      .where(lte(invitationMailClaim.claimedAt, ago(86_400)))
      .limit(100)
      .for("update", { skipLocked: true });
    await transaction.delete(invitationMailClaim).where(inArray(invitationMailClaim.id, stale));
    const [row] = await transaction
      .insert(invitationMailClaim)
      .values({ email, organizationId, claimedAt: now })
      .returning({ id: invitationMailClaim.id });
    return { claimId: row!.id };
  });
}

/** Takes back a claimed mail that was never tried: a refusal counts nothing. */
export async function releaseInvitationMail(database: Database, claimId: number): Promise<void> {
  await database.delete(invitationMailClaim).where(eq(invitationMailClaim.id, claimId));
}
