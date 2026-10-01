// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { aiRequest } from "@braivo/db/schema";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

/**
 * Records one request of the installation's model for an organization — when,
 * with `limit`, fewer than `limit` were recorded for it from `since` to
 * `until` — and says whether it did (docs/adr/0031-ai-limits.md). Bounded at
 * both ends, since requests reach here out of the order they were stamped in:
 * one of next month's recorded first is not this month's.
 *
 * Counting and recording are one step under a lock on the organization, so two
 * requests racing for its last one cannot both have it.
 */
export async function recordAiRequest(
  database: Database,
  input: {
    organizationId: string;
    kind: "read" | "draft";
    userId: string;
    at: Date;
    limit?: { count: number; since: Date; until: Date };
  },
): Promise<boolean> {
  const { organizationId, kind, userId, at, limit } = input;

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
      if ((row?.used ?? 0) >= limit.count) return false;
    }

    await transaction
      .insert(aiRequest)
      .values({ id: crypto.randomUUID(), organizationId, kind, userId, createdAt: at });
    return true;
  });
}
