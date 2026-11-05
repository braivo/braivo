// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";

import { MemberRefused, removeMember, setMemberRole } from "../application/index.ts";
import { type Guards, jsonBody, presentsToolCredential } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

function refused(context: Context, error: MemberRefused) {
  const status = {
    ROLE_NOT_ASSIGNABLE: 400,
    MEMBER_NOT_FOUND: 404,
    MEMBER_IS_OWNER: 409,
    OWN_MEMBERSHIP: 409,
  } as const;
  return context.json({ error: error.message, code: error.code }, status[error.code]);
}

/**
 * Removing a member and giving or taking roles (access-56), by whoever
 * administers the organization, in a browser: a tool changes no one's
 * membership. Better Auth's own `remove-member` and `update-member-role`
 * stay closed (access-26).
 */
export function memberRoutes(
  { trustedJsonWrite, requireAccount }: Guards,
  { database }: { database: Database },
) {
  const routes = new Hono();
  const path = "/api/organizations/:organizationId/members/:userId";

  routes.post(`${path}/remove`, ...trustedJsonWrite(), requireAccount, async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    try {
      await removeMember({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
        userId: context.req.param("userId"),
      });
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof MemberRefused) return refused(context, error);
      return organizationRefusal(context, error);
    }
  });

  routes.post(`${path}/role`, ...trustedJsonWrite(), requireAccount, async (context) => {
    if (presentsToolCredential(context)) return context.body(null, 403);
    const body = (await jsonBody(context)) as { role?: unknown } | null;
    try {
      const member = await setMemberRole({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
        userId: context.req.param("userId"),
        role: body?.role,
      });
      return context.json({ member });
    } catch (error) {
      if (error instanceof MemberRefused) return refused(context, error);
      return organizationRefusal(context, error);
    }
  });

  return routes;
}
