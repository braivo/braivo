// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type * as content from "../content/index.ts";
import type * as learning from "../learning/index.ts";

// The shapes the HTTP API sends and accepts, as `api/index.ts` documents them.
// Derived from the domain types rather than restated, so the client in
// `client.ts` cannot drift from what the routes serialize; `app.test.ts` pins
// the JSON itself.
//
// Type-only: the apps bundle `client.ts`, and nothing here may pull server code
// in with it (`client.test.ts` checks).

/** A value as `JSON.stringify` writes it: every `Date` becomes an ISO 8601 string. */
type Json<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Json<Item>[]
    : T extends object
      ? { [Key in keyof T]: Json<T[Key]> }
      : T;

/** What a learner should do next, as `GET /api/courses/:courseId/next` answers it. */
export type LearningDecision = Json<learning.LearningDecision>;

/** Where a learner stands on one objective. */
export type ObjectiveStanding = Json<learning.ObjectiveStanding>;

/** A learner's standing on each objective in a course, in content order. */
export type KnowledgeReport = Json<learning.KnowledgeReport>;

/**
 * One graded outcome, as it is posted.
 *
 * `id` identifies one attempt's outcome for one objective, never a task: build
 * it from the task alone and every attempt after the first is refused as a 409.
 * `at` is exactly what `Date#toISOString` gives, and at most five minutes ahead
 * of Braivo — a result dated further could never be corrected, since resending
 * its `id` with the right date is a conflict.
 *
 * Named fields rather than the whole of `learning.Evidence`, unlike the
 * responses above: this is a request body, so it is what `parseEvidence`
 * accepts, and a field added to the domain type must not silently become
 * something callers are told to send.
 */
export type GradedEvidence = Json<Pick<learning.Evidence, "id" | "objectiveId" | "outcome" | "at">>;

/** What a learner is to do next, as `GET /api/courses/:courseId/activity` answers it. */
export type Activity = {
  decision: LearningDecision;
  task: { id: string } & content.PresentedTask;
};

/** A learner's answer to a task, as posted in an attempt. */
export type TaskResponse = content.TaskResponse;

/** How an attempt was graded, as `POST /api/courses/:courseId/attempts` answers it. */
export type Grade = content.Grade;

/** A course as its organization's content owners see it listed. */
export type Course = { id: string; title: string };

/** A learning target as its organization's content owners see it listed. */
export type Objective = { id: string; title: string };
