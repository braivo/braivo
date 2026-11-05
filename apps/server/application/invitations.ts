// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import type { Locale } from "@braivo/i18n/locales";
import * as z from "zod";

import { describeError } from "../logging.ts";
import { invitationLink, invitationMail, type SendMail } from "../mail/index.ts";
import {
  claimInvitationMail,
  countMembers,
  type MailBoundCode,
  type MailBounds,
  type PendingInvitation,
  readInvitation,
  readLearnDomain,
  readMemberRolesByEmail,
  readOrganizationInvitation,
  readOrganizationRoles,
  readPendingInvitationRole,
  readPendingInvitations,
  readUser,
  releaseInvitationMail,
  renewInvitation,
} from "../persistence/index.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

export type { PendingInvitation } from "../persistence/index.ts";

/**
 * The roles an invitation may carry (ADR 0018): a learner (`member`), an
 * author, or an administrator. Never `owner`, which only creating an
 * organization gives.
 */
export type InvitableRole = "member" | "author" | "admin";
const INVITABLE_ROLES: ReadonlySet<unknown> = new Set<InvitableRole>(["member", "author", "admin"]);

export const isInvitableRole = (role: unknown): role is InvitableRole => INVITABLE_ROLES.has(role);

/**
 * How much invitation mail goes out (ADR 0018), retries included, refusals
 * not counted: an abuse bound on a school's own invitations, not a quota.
 */
const MAIL_BOUNDS: MailBounds = {
  perAddressPerDay: 3,
  cooldownSeconds: 60,
  perOrganizationPerHour: 300,
};

/** The most distinct addresses one submission invites (ADR 0018): a class, and some. */
const MAX_ADDRESSES = 100;

/** Raw entries read from one submission before any is looked at: a bound on its work. */
const MAX_ENTRIES = 1_000;

/** Addresses invited at once: mail is sent while the request waits (ADR 0033). */
const MAX_CONCURRENT_INVITATIONS = 5;

/**
 * Why a submission or a resend was refused whole, inviting no one: `code` for
 * a client to word it in its language (ADR 0035), `message` the same in
 * English, and what the address already holds there, for a resend.
 */
export class InvitationRefused extends Error {
  constructor(
    readonly code:
      | "EMAILS_INVALID"
      | "TOO_MANY_ADDRESSES"
      | "ROLE_NOT_INVITABLE"
      | "NO_LEARN_DOMAIN"
      | "INVITATION_NOT_FOUND"
      | "NOT_PENDING"
      | "ALREADY_MEMBER"
      | "ALREADY_INVITED"
      | "PENDING_LIMIT"
      | MailBoundCode,
    message: string,
    readonly existing: { roles?: string[]; role?: string } = {},
  ) {
    super(message);
    this.name = "InvitationRefused";
  }
}

/** An invitation made, and whether its mail went: Better Auth stores it before sending. */
type Invited = {
  invitation: { id: string; email: string; role: string; expiresAt: Date };
  emailSent: boolean;
};

/** What inviting one address came to, reported per address (ADR 0018). */
export type InvitationResult =
  | ({ email: string; outcome: "invited" } & Invited)
  | { email: string; outcome: "already a member"; roles: string[] }
  | { email: string; outcome: "already invited"; role: string }
  | {
      email: string;
      outcome: "refused";
      code: "EMAIL_INVALID" | "PENDING_LIMIT" | "NO_LEARN_DOMAIN" | MailBoundCode;
    }
  /** Something unforeseen; trying it again may work. */
  | { email: string; outcome: "failed" };

/** A submission's answer: each distinct address's result, in order, and how many more members fit. */
export type InvitationBatchResult = { results: InvitationResult[]; membersLeft: number };

/** What Better Auth making one invitation came to: the invitation, or what it found in the way. */
export type CreateInvitationResult =
  | Invited
  | "already a member"
  | "already invited"
  | "pending limit"
  | "no learn domain";

/** Better Auth making the invitation as the actor, its hooks run (ADR 0018). */
type CreateInvitation = (invitation: {
  email: string;
  role: InvitableRole;
}) => Promise<CreateInvitationResult>;

async function assertLearnersHaveASite(database: Database, organizationId: string) {
  if (await readLearnDomain(database, organizationId)) return;
  throw new InvitationRefused(
    "NO_LEARN_DOMAIN",
    "Learners have no site here yet; invite them once the organization has one.",
  );
}

/**
 * Invites one address: what it holds already first, then its mail claimed
 * against the bounds, then Better Auth. A refusal from Better Auth releases
 * the claim, since no mail was tried; a failed send keeps it.
 */
async function inviteAddress(input: {
  database: Database;
  organizationId: string;
  email: string;
  role: InvitableRole;
  create: CreateInvitation;
  now: Date;
}): Promise<InvitationResult> {
  const { database, organizationId, email, role, create, now } = input;
  if (!z.email().safeParse(email).success) {
    return { email, outcome: "refused", code: "EMAIL_INVALID" };
  }
  const readExisting = async (): Promise<InvitationResult | undefined> => {
    const roles = await readMemberRolesByEmail(database, { organizationId, email });
    if (roles.length > 0) return { email, outcome: "already a member", roles };
    const pending = await readPendingInvitationRole(database, { organizationId, email, now });
    if (pending) return { email, outcome: "already invited", role: pending };
    return undefined;
  };
  const existing = await readExisting();
  if (existing) return existing;

  const claim = await claimInvitationMail(database, {
    email,
    organizationId,
    now,
    bounds: MAIL_BOUNDS,
  });
  if ("refused" in claim) return { email, outcome: "refused", code: claim.refused };

  let made: CreateInvitationResult;
  try {
    made = await create({ email, role });
  } catch (error) {
    await releaseInvitationMail(database, claim.claimId);
    throw error;
  }
  if (typeof made !== "string") return { email, outcome: "invited", ...made };

  await releaseInvitationMail(database, claim.claimId);
  if (made === "pending limit") return { email, outcome: "refused", code: "PENDING_LIMIT" };
  if (made === "no learn domain") return { email, outcome: "refused", code: "NO_LEARN_DOMAIN" };
  // Joined or invited meanwhile: said as found.
  return (await readExisting()) ?? { email, outcome: "failed" };
}

/**
 * Invites up to 100 addresses to an organization as one role, for whoever
 * administers it (ADR 0018). Addresses are trimmed, lowercased, as Better
 * Auth stores them, and deduplicated in order; each is reported, keeping
 * what it already holds. A learner's need the organization's learn domain,
 * checked once for the whole submission. Answers too how many more members
 * fit: invitations hold no places.
 */
export async function inviteToOrganization(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  emails: unknown;
  role: unknown;
  create: CreateInvitation;
  /** The organization's member limit (`MEMBERSHIP_LIMIT`). */
  memberLimit: number;
  now: () => Date;
}): Promise<InvitationBatchResult> {
  const { database, organizationId, actingAs, role, create, now } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const entries = input.emails;
  if (
    !Array.isArray(entries) ||
    entries.length > MAX_ENTRIES ||
    !entries.every((entry) => typeof entry === "string")
  ) {
    throw new InvitationRefused("EMAILS_INVALID", "Enter one or more email addresses.");
  }
  const emails = [...new Set(entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) {
    throw new InvitationRefused("EMAILS_INVALID", "Enter one or more email addresses.");
  }
  if (emails.length > MAX_ADDRESSES) {
    throw new InvitationRefused(
      "TOO_MANY_ADDRESSES",
      `Invite at most ${MAX_ADDRESSES} addresses at once.`,
    );
  }
  if (!isInvitableRole(role)) {
    throw new InvitationRefused(
      "ROLE_NOT_INVITABLE",
      "Invite as a learner, an author, or an admin.",
    );
  }
  if (role === "member") await assertLearnersHaveASite(database, organizationId);

  const results: InvitationResult[] = Array.from({ length: emails.length });
  let next = 0;
  // Set when the actor stopped administering, or was removed, since the
  // check above: no further address is tried, and the submission is refused.
  let refused: NotPermitted | undefined;
  async function work() {
    while (next < emails.length && !refused) {
      const index = next++;
      const email = emails[index]!;
      results[index] = await inviteAddress({
        database,
        organizationId,
        email,
        role: role as InvitableRole,
        create,
        now: now(),
      }).catch((error: unknown): InvitationResult => {
        if (error instanceof NotPermitted) refused = error;
        // Described, as the error may name the address.
        else
          console.error({
            message: "An invitation could not be made",
            error: describeError(error),
          });
        return { email, outcome: "failed" };
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_INVITATIONS, emails.length) }, work),
  );
  if (refused) throw refused;

  const members = await countMembers(database, organizationId);
  return { results, membersLeft: Math.max(0, input.memberLimit - members) };
}

/**
 * Sends a pending invitation's mail again, for whoever administers its
 * organization (ADR 0018): the same link and role, its expiry renewed, the
 * resender named as inviter, within the mail bounds. An expired one is
 * invited again, a new link. Braivo renews it by ID itself: Better Auth's
 * `resend` finds the invitation by address, reading 100 rows before
 * dropping expired ones, so a live one behind them would not be resent.
 */
export async function resendInvitation(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  invitationId: string;
  create: CreateInvitation;
  sendMail: SendMail;
  baseUrl: string;
  locale: Locale;
  /** How long an invitation lasts (`INVITATION_DAYS`). */
  invitationDays: number;
  now: Date;
}): Promise<InvitationResult & { outcome: "invited" }> {
  const { database, organizationId, actingAs, invitationId, now } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const found = await readOrganizationInvitation(database, { organizationId, invitationId });
  if (!found) throw new InvitationRefused("INVITATION_NOT_FOUND", "No such invitation.");
  if (found.status !== "pending") {
    throw new InvitationRefused("NOT_PENDING", "This invitation was accepted or cancelled.");
  }
  // Better Auth's hooks are not asked when renewing: checked here.
  if (found.role === "member") await assertLearnersHaveASite(database, organizationId);
  if (!isInvitableRole(found.role)) {
    throw new InvitationRefused("ROLE_NOT_INVITABLE", "This invitation's role is not offered.");
  }

  if (found.expiresAt <= now) {
    const invited = await inviteAddress({
      database,
      organizationId,
      email: found.email,
      role: found.role,
      create: input.create,
      now,
    });
    if (invited.outcome === "invited") return invited;
    throw refusalOf(invited);
  }

  // Read before the claim, so only the renewal stands between it and the mail.
  const [stored, inviter] = await Promise.all([
    readInvitation(database, invitationId),
    readUser(database, actingAs),
  ]);
  const claim = await claimInvitationMail(database, {
    email: found.email,
    organizationId,
    now,
    bounds: MAIL_BOUNDS,
  });
  if ("refused" in claim) throw boundRefusal(claim.refused);
  // No mail tried yet: a refusal or a failure here counts nothing.
  const renewed = await renewInvitation(database, {
    invitationId,
    now,
    expiresAt: new Date(now.getTime() + input.invitationDays * 86_400_000),
  }).catch(async (error: unknown) => {
    await releaseInvitationMail(database, claim.claimId);
    throw error;
  });
  if (!renewed) {
    await releaseInvitationMail(database, claim.claimId);
    throw new InvitationRefused("NOT_PENDING", "This invitation was accepted or cancelled.");
  }

  let emailSent = true;
  try {
    await input.sendMail(
      invitationMail({
        to: renewed.email,
        link: invitationLink(input.baseUrl, renewed.id),
        organization: stored?.organization.name ?? "",
        inviter: inviter?.name || inviter?.email || "",
        role: renewed.role as InvitableRole,
        expiresAt: renewed.expiresAt,
        locale: input.locale,
      }),
    );
  } catch (error) {
    // Counted all the same: a send was tried. Described, as it may name the address.
    console.error({ message: "An invitation could not be resent", error: describeError(error) });
    emailSent = false;
  }
  return { email: renewed.email, outcome: "invited", invitation: renewed, emailSent };
}

function boundRefusal(bound: MailBoundCode): InvitationRefused {
  const message = {
    RECIPIENT_DAILY_LIMIT:
      "This address was sent three invitations in the last 24 hours; try later.",
    RECIPIENT_COOLDOWN: "This address was sent an invitation a moment ago; wait a minute.",
    ORGANIZATION_HOURLY_LIMIT: "This organization sent 300 invitations this hour; wait a while.",
  }[bound];
  return new InvitationRefused(bound, message);
}

/** One address's result, other than invited, as a resend's refusal, or an error past saying. */
function refusalOf(result: InvitationResult): Error {
  switch (result.outcome) {
    case "already a member":
      return new InvitationRefused("ALREADY_MEMBER", "This address is already a member.", {
        roles: result.roles,
      });
    case "already invited":
      return new InvitationRefused("ALREADY_INVITED", "This address is already invited.", {
        role: result.role,
      });
    case "refused":
      if (result.code === "PENDING_LIMIT") {
        return new InvitationRefused("PENDING_LIMIT", "Too many invitations are waiting.");
      }
      if (result.code === "NO_LEARN_DOMAIN") {
        return new InvitationRefused("NO_LEARN_DOMAIN", "Learners have no site here yet.");
      }
      // Stored by Better Auth, so never malformed.
      if (result.code === "EMAIL_INVALID") break;
      return boundRefusal(result.code);
    default:
      break;
  }
  return new Error("The invitation could not be made again.");
}

/**
 * An organization's invitations waiting to be accepted, for whoever
 * administers it, and how many more members fit.
 */
export async function listInvitations(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  memberLimit: number;
  now: Date;
}): Promise<{ invitations: PendingInvitation[]; membersLeft: number }> {
  const { database, organizationId, actingAs, now } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  const [invitations, members] = await Promise.all([
    readPendingInvitations(database, { organizationId, now }),
    countMembers(database, organizationId),
  ]);
  return { invitations, membersLeft: Math.max(0, input.memberLimit - members) };
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
  /**
   * A learner's invitation, to its recipient: the hostname they continue on,
   * the organization's latest, or `null` while it has none (ADR 0018).
   */
  learnDomain?: string | null;
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

  const email = (await readUser(database, viewer))?.email;
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
    ...(found.role === "member" && {
      learnDomain: (await readLearnDomain(database, found.organizationId)) ?? null,
    }),
  };
}
