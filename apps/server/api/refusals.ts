// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How a route turns a use case's refusal into an answer, and `secondsUntil`,
// which a refusal's `Retry-After` and the activity's `retryAfter` both count by.

import type { Context } from "hono";

import {
  AiLimitReached,
  AiNotEntitled,
  AiUnavailable,
  ConflictingEvidence,
  ConflictingKey,
  FilesUnavailable,
  InvalidAiRequest,
  InvalidCitation,
  InvalidDefinition,
  InvalidEvidence,
  InvalidFile,
  InvalidSource,
  InvalidTask,
  ModelUnavailable,
  NotPermitted,
  StaleCorrection,
} from "../application/index.ts";

/**
 * How a route under `/api/organizations` answers its use case's refusals,
 * alike on every one; anything else is rethrown. Its caller named the
 * organization, so `NotPermitted` is a bare 403, not a 404: it tells them
 * nothing they did not assert. Its caller is often an agent that can fix what
 * it sent ("quote more of it"), so the rest come explained, each saying whose
 * fix it is: the caller's for 400 and 409, the operator's for 501 and an AI
 * 403, the calendar's for 429, nobody's but a retry's for 502. Never for a
 * learner route, whose result's union says how it refuses.
 */
export function organizationRefusal(context: Context, error: unknown): Response {
  // A grader's, bare: a malformed body is 400 either way, and nothing was
  // recorded. 409, not 400, when evidence disagrees with what is stored, or
  // a grader would look at its format rather than at how it builds IDs.
  if (error instanceof InvalidEvidence) return context.body(null, 400);
  if (error instanceof ConflictingEvidence) return context.body(null, 409);

  if (
    error instanceof InvalidDefinition ||
    error instanceof InvalidTask ||
    error instanceof InvalidCitation ||
    error instanceof InvalidSource ||
    error instanceof InvalidFile ||
    error instanceof InvalidAiRequest
  ) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof ConflictingKey || error instanceof StaleCorrection) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof AiUnavailable || error instanceof FilesUnavailable) {
    return context.json({ error: error.message }, 501);
  }
  if (error instanceof AiNotEntitled) return context.json({ error: error.message }, 403);
  if (error instanceof AiLimitReached) {
    context.header("retry-after", String(secondsUntil(error.renewsAt, new Date())));
    return context.json({ error: error.message }, 429);
  }
  if (error instanceof ModelUnavailable) return context.json({ error: error.message }, 502);
  if (error instanceof NotPermitted) return context.body(null, 403);
  throw error;
}

/**
 * Whole seconds until `when`, rounded up so a client waiting that long is never
 * early. A duration, not a date: the client's clock may disagree with this one.
 */
export function secondsUntil(when: Date, now: Date): number {
  return Math.ceil((when.getTime() - now.getTime()) / 1000);
}
