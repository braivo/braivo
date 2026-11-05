// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";

import {
  dismissReports,
  type FirstAnswersScope,
  listReportedTasks,
  MAX_REPORTS_AT_ONCE,
  readFirstAnswers,
  type ReportScope,
} from "../application/index.ts";
import { type Guards, jsonBody, presentsToolCredential } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

/** The one scope a read names, or `undefined` for more than one, or an empty ID. */
function parseScope(context: Context): ReportScope | undefined {
  const named = (["objectiveId", "courseId", "taskId"] as const).flatMap((key) =>
    (context.req.queries(key) ?? []).map((value) => ({ key, value })),
  );
  if (named.length === 0) return {};
  const [only] = named;
  if (named.length > 1 || !only?.value) return undefined;
  return { [only.key]: only.value } as ReportScope;
}

/** A course or an objective, exactly one, or `undefined`. */
function parseFirstAnswersScope(context: Context): FirstAnswersScope | undefined {
  const scope = parseScope(context);
  if (scope === undefined) return undefined;
  if ("courseId" in scope) return { courseId: scope.courseId };
  return "objectiveId" in scope ? { objectiveId: scope.objectiveId } : undefined;
}

/** Report IDs to dismiss, 1 to `MAX_REPORTS_AT_ONCE`, or `undefined`. */
function parseReportIds(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { reportIds } = body as { reportIds?: unknown };
  return Array.isArray(reportIds) &&
    reportIds.length > 0 &&
    reportIds.length <= MAX_REPORTS_AT_ONCE &&
    reportIds.every((id) => typeof id === "string" && id !== "")
    ? (reportIds as string[])
    : undefined;
}

/**
 * Learners' reports of tasks, read and dismissed by whoever administers the
 * organization, in a browser alone (ADR 0052), and, for the same readers, how
 * learners first answered each task (progress-18). A tool's refusal is
 * explained here; the use cases refuse it too.
 */
export function reportRoutes(
  { trustedJsonWrite, requireAccount }: Guards,
  { database }: { database: Database },
) {
  const routes = new Hono();
  const refuseTool = (context: Context) =>
    context.json({ error: "Read learners' reports in Braivo's console." }, 403);

  routes.get(
    "/api/organizations/:organizationId/first-answers",
    requireAccount,
    async (context) => {
      if (presentsToolCredential(context)) {
        return context.json({ error: "Read learners' first answers in Braivo's console." }, 403);
      }
      const scope = parseFirstAnswersScope(context);
      if (scope === undefined) return context.body(null, 400);

      try {
        const summary = await readFirstAnswers({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          accessKind: context.var.accessKind,
          scope,
        });
        return summary === undefined ? context.body(null, 404) : context.json(summary);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  routes.get("/api/organizations/:organizationId/reports", requireAccount, async (context) => {
    if (presentsToolCredential(context)) return refuseTool(context);
    const scope = parseScope(context);
    if (scope === undefined) return context.body(null, 400);

    try {
      return context.json(
        await listReportedTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          accessKind: context.var.accessKind,
          scope,
        }),
      );
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  routes.post(
    "/api/organizations/:organizationId/reports/dismiss",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      if (presentsToolCredential(context)) return refuseTool(context);
      const reportIds = parseReportIds(await jsonBody(context));
      if (reportIds === undefined) return context.body(null, 400);

      try {
        await dismissReports({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          accessKind: context.var.accessKind,
          reportIds,
          now: new Date(),
        });
        return context.body(null, 204);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  return routes;
}
