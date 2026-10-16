// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { disconnectConnection, listConnections } from "../application/index.ts";
import { type Guards, presentsToolCredential } from "./guards.ts";

/**
 * A person's remote MCP connections (ADR 0045, access-42): listed, and one
 * disconnected. Their browser's alone: a tool's token or connection manages
 * no account (ADR 0022), and a connection must not end another, or itself.
 */
export function connectionRoutes(
  { sessionFor, trustedJsonWrite }: Guards,
  { database }: { database: Database },
) {
  const routes = new Hono();

  /** The browser's session, `userId`: 403 for a tool's credential, 401 for none. */
  const requireBrowser = createMiddleware<{ Variables: { userId: string } }>(
    async (context, next) => {
      if (presentsToolCredential(context)) return context.body(null, 403);
      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);
      context.set("userId", session.userId);
      await next();
    },
  );

  routes.get("/api/connections", requireBrowser, async (context) =>
    context.json({
      connections: await listConnections({ database, actingAs: context.var.userId }),
    }),
  );

  routes.post(
    "/api/connections/:connectionId/disconnect",
    ...trustedJsonWrite(),
    requireBrowser,
    async (context) => {
      const disconnected = await disconnectConnection({
        database,
        actingAs: context.var.userId,
        connectionId: context.req.param("connectionId"),
      });
      return context.body(null, disconnected ? 204 : 404);
    },
  );

  return routes;
}
