// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";

import {
  InvitationRefused,
  inviteToOrganization,
  listInvitations,
  readInvitationPage,
} from "../application/index.ts";
import { type Auth, createInvitation } from "../auth/index.ts";
import { mailLocale } from "../mail/index.ts";
import { type Guards, jsonBody, presentsToolCredential } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

/**
 * Invitations to an organization (ADR 0018): made and listed by whoever
 * administers it, in a browser; a tool neither invites nor reads invitees'
 * emails. Accepting is Better Auth's own `accept-invitation`.
 */
export function invitationRoutes(
  { trustedJsonWrite, requireAccount, sessionFor }: Guards,
  { auth, database }: { auth: Auth; database: Database },
) {
  const routes = new Hono();
  const path = "/api/organizations/:organizationId/invitations";

  routes.post(path, ...trustedJsonWrite(), requireAccount, async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    const body = (await jsonBody(context)) as { email?: unknown; role?: unknown } | null;
    if (typeof body?.email !== "string") return context.body(null, 400);
    const organizationId = context.req.param("organizationId");

    try {
      const made = await inviteToOrganization({
        database,
        organizationId,
        actingAs: context.var.userId,
        email: body.email,
        role: body.role,
        create: ({ email, role }) =>
          createInvitation(auth, {
            headers: context.req.raw.headers,
            organizationId,
            email,
            role,
            // The inviter's: the invitee has none Braivo knows yet.
            locale: mailLocale(context.req.header("accept-language")),
          }),
      });
      return context.json(made, 201);
    } catch (error) {
      if (!(error instanceof InvitationRefused)) return organizationRefusal(context, error);
      const conflict = error.code !== "EMAIL_INVALID" && error.code !== "ROLE_NOT_INVITABLE";
      return context.json(
        { error: error.message, code: error.code, ...error.held },
        conflict ? 409 : 400,
      );
    }
  });

  routes.get(path, requireAccount, async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    try {
      const invitations = await listInvitations({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
        now: new Date(),
      });
      return context.json({ invitations });
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
