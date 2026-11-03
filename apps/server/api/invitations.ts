// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";

import {
  cancelInvitation,
  type InvitableRole,
  InvitationRefused,
  inviteToOrganization,
  listInvitations,
  readInvitationPage,
  resendInvitation,
} from "../application/index.ts";
import { type Auth, createInvitation, INVITATION_DAYS, MEMBERSHIP_LIMIT } from "../auth/index.ts";
import { mailLocale, type SendMail } from "../mail/index.ts";
import {
  disableBunIdleTimeout,
  type Guards,
  jsonBody,
  perClientLimit,
  presentsToolCredential,
} from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

/**
 * Requests a minute from one client to invite or resend: Better Auth's own
 * limits do not run for an in-process call (ADR 0018). The mail bounds hold
 * whatever this admits; this bounds the work.
 */
const CLIENT_LIMIT = 60;

/** A whole request's refusal: its status, and its code and English words. */
function refused(context: Context, error: InvitationRefused) {
  const status =
    (
      {
        EMAILS_INVALID: 400,
        TOO_MANY_ADDRESSES: 400,
        ROLE_NOT_INVITABLE: 400,
        INVITATION_NOT_FOUND: 404,
        RECIPIENT_DAILY_LIMIT: 429,
        RECIPIENT_COOLDOWN: 429,
        ORGANIZATION_HOURLY_LIMIT: 429,
      } as const
    )[error.code as string] ?? 409;
  return context.json({ error: error.message, code: error.code, ...error.existing }, status);
}

/**
 * Invitations to an organization (ADR 0018): made, resent, cancelled, and listed by
 * whoever administers it, in a browser; a tool neither invites nor reads
 * invitees' emails. Accepting is Better Auth's own `accept-invitation`.
 */
export function invitationRoutes(
  { trustedJsonWrite, requireAccount, sessionFor }: Guards,
  {
    auth,
    database,
    baseUrl,
    sendMail,
  }: { auth: Auth; database: Database; baseUrl: string; sendMail: SendMail },
) {
  const routes = new Hono();
  const path = "/api/organizations/:organizationId/invitations";

  /** Better Auth making one invitation as the request's session, mailing in the inviter's language. */
  const creator = (context: Context, organizationId: string) => {
    // The inviter's: the invitee has none Braivo knows yet.
    const locale = mailLocale(context.req.header("accept-language"));
    return ({ email, role }: { email: string; role: InvitableRole }) =>
      createInvitation(auth, {
        headers: context.req.raw.headers,
        organizationId,
        email,
        role,
        locale,
      });
  };

  routes.post(
    path,
    perClientLimit(auth, CLIENT_LIMIT),
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      if (presentsToolCredential(context)) return context.body(null, 403);
      const body = (await jsonBody(context)) as { emails?: unknown; role?: unknown } | null;
      const organizationId = context.req.param("organizationId");
      // Each address may wait on its mail, sent while the request waits (ADR 0033).
      disableBunIdleTimeout(context);
      try {
        return context.json(
          await inviteToOrganization({
            database,
            organizationId,
            actingAs: context.var.userId,
            emails: body?.emails,
            role: body?.role,
            create: creator(context, organizationId),
            memberLimit: MEMBERSHIP_LIMIT,
            now: () => new Date(),
          }),
        );
      } catch (error) {
        if (error instanceof InvitationRefused) return refused(context, error);
        return organizationRefusal(context, error);
      }
    },
  );

  routes.post(
    `${path}/:invitationId/resend`,
    perClientLimit(auth, CLIENT_LIMIT),
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      if (presentsToolCredential(context)) return context.body(null, 403);
      const organizationId = context.req.param("organizationId");
      disableBunIdleTimeout(context);
      try {
        return context.json(
          await resendInvitation({
            database,
            organizationId,
            actingAs: context.var.userId,
            invitationId: context.req.param("invitationId"),
            create: creator(context, organizationId),
            sendMail,
            baseUrl,
            locale: mailLocale(context.req.header("accept-language")),
            invitationDays: INVITATION_DAYS,
            now: new Date(),
          }),
        );
      } catch (error) {
        if (error instanceof InvitationRefused) return refused(context, error);
        return organizationRefusal(context, error);
      }
    },
  );

  routes.post(
    `${path}/:invitationId/cancel`,
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      if (presentsToolCredential(context)) return context.body(null, 403);
      try {
        return context.json(
          await cancelInvitation({
            database,
            organizationId: context.req.param("organizationId"),
            actingAs: context.var.userId,
            invitationId: context.req.param("invitationId"),
          }),
        );
      } catch (error) {
        if (error instanceof InvitationRefused) return refused(context, error);
        return organizationRefusal(context, error);
      }
    },
  );

  routes.get(path, requireAccount, async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    try {
      return context.json(
        await listInvitations({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          memberLimit: MEMBERSHIP_LIMIT,
          now: new Date(),
        }),
      );
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  /**
   * An invitation as its page shows it, to anyone with the link: the
   * school's name and its state, and more only to the account it was sent to
   * (`readInvitationPage`). Its ID is the secret; one unknown is a 404.
   */
  routes.get("/api/invitations/:invitationId", async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    const session = await sessionFor(context);
    const page = await readInvitationPage({
      database,
      invitationId: context.req.param("invitationId"),
      viewer: session?.userId,
      now: new Date(),
    });
    return page ? context.json(page) : context.body(null, 404);
  });

  return routes;
}
