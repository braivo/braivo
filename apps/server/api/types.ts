// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type * as application from "../application/index.ts";
import type * as content from "../content/index.ts";
import type * as learning from "../learning/index.ts";

// The shapes the HTTP API sends and accepts, as `api/index.ts` documents them.
// Derived from the domain and use-case types rather than restated, so the client in
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

/** A learner's standing on each objective in a course, in content order. */
export type LearnerProgressReport = Json<application.LearnerProgressReport>;

/** Where a learner stands on one objective, by its ID and title. */
export type LearnerProgressStanding = LearnerProgressReport["objectives"][number];

/** Where each learner in a course stands, counted, as `GET /api/courses/:courseId/progress` answers it. */
export type CourseProgressOverview = Json<application.CourseProgressOverview>;

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

/**
 * What a learner is to do next, as `GET /api/courses/:courseId/activity`
 * answers it: the decided objective and a task to answer now; the decision
 * without a task when its objective has none (glossary: No activity); or, when
 * every task for it was answered too recently, the objective and in how many
 * seconds to ask again.
 */
export type Activity =
  | {
      decision: LearningDecision;
      objective: Objective;
      task: { id: string } & content.PresentedTask;
    }
  | { decision: LearningDecision; objective: Objective }
  | { objective: Objective; retryAfter: number };

/** A learner's answer to a task, as posted in an attempt. */
export type TaskResponse = content.TaskResponse;

/**
 * How an attempt was graded, as `POST /api/courses/:courseId/attempts` answers
 * it: with the passages the task was written from, when it cites any.
 */
export type Grade = content.Grade & { passages?: Passage[] };

/** A passage a graded task was written from: the words, and where they are from. */
export type Passage = application.Passage;

/** A course as its organization's content owners see it listed. */
export type Course = { id: string; title: string };

/** A learning target, by ID and title. */
export type Objective = { id: string; title: string };

/** An organization as those who manage it find it; `slug` is its console address. */
export type Organization = { id: string; name: string; slug: string };

/** A member as those who manage the organization see them: no email. */
export type Member = { userId: string; name: string; roles: string[] };

/** The organization a domain serves, as its learn app presents itself. */
export type HostOrganization = { name: string };

/** Who is signed in on the host asked (`GET /api/session`). */
export type SessionUser = { id: string; name: string };

/** How `/login` may sign people in besides an emailed code (`GET /api/sign-in-methods`). */
export type SignInMethods = { google: boolean };

/** What a learn domain's sign-in signs in to, for the installation's `/login` to say. */
export type Handoff = { organization: { name: string }; hostname: string };

/** A source as its organization's content owners see it listed: everything but its text. */
export type SourceSummary = Json<application.SourceSummary>;

/** A source, text included, as `GET …/sources/:sourceId` answers it. */
export type Source = Json<application.Source>;

/** A quote to cite for an objective, as it is posted: Braivo finds where it is. */
export type QuotedCitation = application.QuotedCitation;

/** Where Braivo found a cited quote, in code points of its source's text. */
export type LocatedCitation = application.Citation;

/**
 * A task as it is authored: an objective, the fields of its kind, and the
 * passages it was written from, each a quote Braivo locates; with `replaces`,
 * a correction of that task (`defineTasks`).
 */
export type TaskDraft = content.TaskBody & {
  objectiveId: string;
  citations?: { sourceId: string; quote: string }[];
  replaces?: string;
};

/**
 * A course drafted from a source by the installation's model: objectives with
 * keys, citations, and tasks in the shapes the authoring methods take, and
 * what was refused. Nothing in it is stored until it is authored.
 */
export type Draft = application.Draft;

/**
 * A course as authored: its objectives in the order learners meet them, each
 * with the passages that teach it and its tasks, answers included.
 */
export type AuthoredCourse = Course & {
  objectives: {
    id: string;
    title: string;
    citations: { sourceId: string; start: number; end: number; quote: string }[];
    tasks: AuthoredTask[];
  }[];
  /** Every source the passages above are from, once. */
  sources: SourceSummary[];
};

/**
 * A task read back as it was authored, answer included, with its ID and the
 * passages it cites — where Braivo found each, and the words there.
 */
export type AuthoredTask = content.TaskBody & {
  id: string;
  citations: { sourceId: string; start: number; end: number; quote: string }[];
};
