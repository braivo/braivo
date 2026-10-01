// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { Model } from "../ai/index.ts";
import { recordAiRequest } from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/**
 * The installation's model, and whom its operator lets spend on it: every
 * organization, or those it names, since the credits are the operator's
 * (docs/adr/0029-server-drafting.md).
 */
export type Ai = {
  model: Model;
  organizations: "all" | ReadonlySet<string>;
  /** Requests each organization may make a calendar month, UTC; none means no limit. */
  monthlyLimit?: number;
};

/** An organization that has made its month's requests; it may again from `renewsAt`. */
export class AiLimitReached extends Error {
  constructor(
    limit: number,
    readonly renewsAt: Date,
  ) {
    super(
      `This organization has used its ${limit} AI requests for this month; more from ${renewsAt.toISOString().slice(0, 10)}, or use your own desktop agent through braivo mcp.`,
    );
    this.name = "AiLimitReached";
  }
}

/** This installation was started without a model, so asks none. */
export class AiUnavailable extends Error {
  constructor() {
    super(
      "This Braivo installation has no AI of its own: its operator has not set ANTHROPIC_API_KEY. Use your own desktop agent through braivo mcp.",
    );
    this.name = "AiUnavailable";
  }
}

/** An organization the operator has not let use the installation's model. */
export class AiNotEntitled extends Error {
  constructor() {
    super(
      "This organization may not use this installation's AI; ask its operator, or use your own desktop agent through braivo mcp.",
    );
    this.name = "AiNotEntitled";
  }
}

/** A request of the model that cannot be answered as sent. Nothing was asked of it. */
export class InvalidAiRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAiRequest";
  }
}

/**
 * The model, for an actor who administers the organization when its operator
 * lets that organization spend on it; refused otherwise. `charge` counts one
 * request against the organization's month, and is called just before the
 * model is asked — so a request refused as invalid costs nothing, and one the
 * model fails still counts, as an attempt that may have been paid for
 * (docs/adr/0031-ai-limits.md). It refuses once the month's are used.
 */
export async function modelFor(
  database: Database,
  ai: Ai | undefined,
  actor: { organizationId: string; actingAs: string },
): Promise<{ model: Model; charge: (kind: "read" | "draft", now: Date) => Promise<void> }> {
  if (ai === undefined) throw new AiUnavailable();

  const { organizationId, actingAs } = actor;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  // After permission, so a stranger learns nothing of which organizations may.
  if (ai.organizations !== "all" && !ai.organizations.has(organizationId)) {
    throw new AiNotEntitled();
  }

  const { model, monthlyLimit } = ai;
  async function charge(kind: "read" | "draft", now: Date): Promise<void> {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const recorded = await recordAiRequest(database, {
      organizationId,
      kind,
      userId: actingAs,
      at: now,
      limit: monthlyLimit === undefined ? undefined : { count: monthlyLimit, since, until },
    });
    if (!recorded) throw new AiLimitReached(monthlyLimit!, until);
  }
  return { model, charge };
}
