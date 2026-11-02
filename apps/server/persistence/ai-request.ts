// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { aiRequest } from "@braivo/db/schema";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

/**
 * How a request of the model went, as its ledger row is completed: numbers and
 * kinds only, never content or a message.
 */
export type AiRequestCompletion =
  | { outcome: "succeeded"; counts: object }
  | { outcome: "failed"; failure: string }
  | { outcome: "aborted" };

/**
 * Reserves one request of the installation's model for an organization — when,
 * with `limit`, fewer than `limit` were recorded for it from `since` to
 * `until` — and answers its ID, or `undefined` when the limit is reached
 * (docs/adr/0031-ai-limits.md). Bounded at both ends, since requests reach
 * here out of the order they were stamped in: one of next month's recorded
 * first is not this month's. Every row counts, however it went.
 *
 * Counting and recording are one step under a lock on the organization, so two
 * requests racing for its last one cannot both have it.
 */
export async function reserveAiRequest(
  database: Database,
  input: {
    organizationId: string;
    kind: "read" | "draft";
    userId: string;
    at: Date;
    model: string;
    promptVersion: string;
    limit?: { count: number; since: Date; until: Date };
  },
): Promise<string | undefined> {
  const { organizationId, kind, userId, at, model, promptVersion, limit } = input;

  return database.transaction(async (transaction) => {
    if (limit) {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`braivo:ai:${organizationId}`}, 0))`,
      );
      const [row] = await transaction
        .select({ used: count() })
        .from(aiRequest)
        .where(
          and(
            eq(aiRequest.organizationId, organizationId),
            gte(aiRequest.createdAt, limit.since),
            lt(aiRequest.createdAt, limit.until),
          ),
        );
      if ((row?.used ?? 0) >= limit.count) return undefined;
    }

    const id = crypto.randomUUID();
    await transaction
      .insert(aiRequest)
      .values({ id, organizationId, kind, userId, createdAt: at, model, promptVersion });
    return id;
  });
}

/**
 * Completes a reserved request with how it went, once: a row already
 * completed keeps its first outcome.
 */
export async function completeAiRequest(
  database: Database,
  id: string,
  completion: AiRequestCompletion & { at: Date },
): Promise<void> {
  await database
    .update(aiRequest)
    .set({
      outcome: completion.outcome,
      failure: completion.outcome === "failed" ? completion.failure : null,
      counts: completion.outcome === "succeeded" ? completion.counts : null,
      completedAt: completion.at,
    })
    .where(and(eq(aiRequest.id, id), eq(aiRequest.outcome, "unknown")));
}

/** An organization's AI requests from `since`, or every organization's, as the operator's report reads them: no user, no content. */
export async function readAiRequests(
  database: Database,
  filter: { since: Date; organizationId?: string },
): Promise<
  {
    kind: string;
    model: string | null;
    promptVersion: string | null;
    outcome: string;
    failure: string | null;
    counts: unknown;
  }[]
> {
  return database
    .select({
      kind: aiRequest.kind,
      model: aiRequest.model,
      promptVersion: aiRequest.promptVersion,
      outcome: aiRequest.outcome,
      failure: aiRequest.failure,
      counts: aiRequest.counts,
    })
    .from(aiRequest)
    .where(
      and(
        gte(aiRequest.createdAt, filter.since),
        filter.organizationId === undefined
          ? undefined
          : eq(aiRequest.organizationId, filter.organizationId),
      ),
    );
}
