// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type * as application from "../application/index.ts";
import type * as content from "../content/index.ts";
import type * as learning from "../learning/index.ts";

// The shapes the HTTP API sends and accepts, as `api/index.ts` documents them.
// Derived from the domain and use-case types rather than restated, so the client in
// `client.ts` cannot drift from what the routes serialize; the API's tests,
// such as `learning.test.ts`, pin the JSON itself.
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

/** As `LearnerProgressReport`, without each objective's evidence (`includeHistory: false`). */
export type LearnerProgressSummary = Json<application.LearnerProgressSummary>;

/** Where a learner stands on one objective, by its ID and title. */
export type LearnerProgressStanding = LearnerProgressSummary["objectives"][number];

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
 * every objective with a task that needs attention was answered too recently
 * (even if one without a task needs attention), the objective whose rest ends
 * first and in how many seconds to ask again; or, when only objectives not
 * started yet are left and as many were started today as a day allows, that
 * limit.
 */
export type Activity =
  | {
      decision: LearningDecision;
      objective: Objective;
      task: { id: string } & content.PresentedTask;
    }
  | { decision: LearningDecision; objective: Objective }
  | { objective: Objective; retryAfter: number }
  | { dailyLimit: number };

/** A learner's answer to a task, as posted in an attempt. */
export type TaskResponse = content.TaskResponse;

/**
 * How an attempt was graded, as `POST /api/courses/:courseId/attempts` answers
 * it: with the passages the task was written from, when it cites any.
 */
export type Grade = content.Grade & { passages?: Passage[] };

/** A passage a graded task was written from: the words, and where they are from. */
export type Passage = application.Passage;

/**
 * A course as its learners see it listed; `number` names it in learners' links
 * within its organization, and `urlLabel` follows it there, to read
 * (`courseRef`).
 */
export type Course = { id: string; number: number; title: string; urlLabel: string };

/**
 * A course as those allowed to author in its organization see it: `published` once a
 * person published it in the console, before which no learner reaches it;
 * `hidden` while a person has hidden it from learners since (ADR 0039).
 */
export type ManagedCourse = Course & { published: boolean; hidden: boolean };

/**
 * A course as its organization lists it: `pendingTaskCount`, how many tasks of its
 * objectives wait for review, a task of an objective two courses share counted
 * in both.
 */
export type CourseSummary = ManagedCourse & { pendingTaskCount: number };

/** A learning target, by ID and title. */
export type Objective = { id: string; title: string };

/**
 * An objective as its organization lists it: `courseIds`, the courses it is
 * in, which its tasks serve; `pendingTaskCount`, its tasks pending review.
 */
export type ObjectiveSummary = Objective & { courseIds: string[]; pendingTaskCount: number };

/**
 * An organization as those who work in it find it; `slug` is its console
 * address, `learnDomain` the hostname its learners practise on, the latest
 * of its learn domains registered, `null` until one is. `administers`: the
 * reader holds `owner` or `admin` there; `authors`: they manage its content,
 * as those or `author` (ADR 0048); `teaches`: they teach one of its groups
 * (ADR 0042). Listed when any is true. `aiEnabled`, only where they author:
 * whether they may have the installation's AI read a file's text and draft
 * courses (generation-9).
 */
export type Organization = {
  id: string;
  name: string;
  slug: string;
  learnDomain: string | null;
  administers: boolean;
  authors: boolean;
  teaches: boolean;
  aiEnabled?: boolean;
};

/** Self-serve setup (ADR 0018), and its data regions (ADR 0040), as `api/index.ts` documents. */
export type OrganizationSetup = {
  domain: string;
  /** Owning none, this account may set one up; owning one, it may not. */
  maySetUp: boolean;
  dataRegion: string | null;
  otherRegions: { region: string; setupUrl: string | null }[];
};

/** A member as those who manage the organization see them: no email. */
export type Member = { userId: string; name: string; roles: string[] };

/** One of a person's remote MCP connections, as `GET /api/connections` lists it (access-42). */
export type Connection = Json<application.Connection>;

/**
 * An organization's learners and teachers taking some of its courses together
 * (ADR 0042), as listed: people by name, courses by title.
 */
export type Group = application.Group;

/** A group whole, as creating one sends it. */
export type GroupDefinition = application.GroupDefinition;

/** A change to a group, naming only what changes. */
export type GroupChange = application.GroupChange;

/**
 * A hostname serving an organization's learn app, and whether its `owner` or
 * `admin` may remove it here: never the installation's own, nor the last.
 */
export type Domain = { hostname: string; removable: boolean };

/** A hostname an organization claimed, not yet serving, with where it stands (ADR 0038). */
export type DomainClaim = application.DomainClaim;

/**
 * An organization's domains, newest first, the first naming its learn domain;
 * its claims; and whether this installation can prove a new one.
 */
export type DomainList = { domains: Domain[]; claims: DomainClaim[]; canAdd: boolean };

/** The organization a domain serves, as its learn app presents itself. */
export type HostOrganization = { name: string };

/** Who is signed in on the host asked (`GET /api/session`). */
export type SessionUser = { id: string; name: string };

/**
 * What `/login` offers besides an emailed code (`GET /api/sign-in-settings`):
 * Google, and the operator's privacy policy and terms, which signing in agrees
 * to, both or neither.
 */
export type SignInSettings = { google: boolean; legal: { privacy: string; terms: string } | null };

/** What a learn domain's sign-in signs in to, for the installation's `/login` to say. */
export type Handoff = { organization: { name: string }; hostname: string };

/** A source as its organization's content owners see it listed: everything but its text. */
export type SourceSummary = Json<application.SourceSummary>;

/** A source, text included, as `GET …/sources/:sourceId` answers it. */
export type Source = Json<application.Source>;

/** A bounded part of a source, as `GET …/sources/:sourceId?pages=…` answers it. */
export type SourceSlice = SourceSummary & content.SourceSlice;

/** What part of a source to read: one of `pages`, `seconds`, or `characters`, as `A-B` or `A-`. */
export type SourceRange = content.SourceRange;

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
export type AuthoredCourse = ManagedCourse & {
  objectives: {
    id: string;
    title: string;
    citations: { sourceId: string; start: number; end: number; quote: string }[];
    tasks: AuthoredTask[];
    /**
     * The organization's other published courses it is in: a task of it,
     * once published, reaches their learners too.
     */
    otherPublishedCourses: { id: string; title: string }[];
  }[];
  /** Every source the passages above are from, once. */
  sources: SourceSummary[];
};

/**
 * A task read back as it was authored, answer included, with its ID and the
 * passages it cites — where Braivo found each, and the words there. Not
 * `published` while it waits for its owner to publish it in the console,
 * offered in no course (ADR 0039). A pending correction of a published task
 * names that task in `replaces`; the task stays offered until the correction
 * is published. A pending task identical to a retired one of its objective
 * (ADR 0024's twin), however retired, is marked `matchesRetiredTask`: often a
 * task sent again after its review.
 */
export type AuthoredTask = content.TaskBody & {
  id: string;
  citations: { sourceId: string; start: number; end: number; quote: string }[];
  published: boolean;
  replaces?: string;
  matchesRetiredTask?: true;
};

/**
 * What adding a task did, and what learners reach of it (ADR 0039): `added`,
 * false for an unretired twin answered instead (ADR 0024), as is a task
 * repeated within the request after its first; `published`, false while it
 * waits for Publish in the console; `replaces`, only while it is a pending
 * correction, the published task it will retire, offered meanwhile.
 */
export type TaskWriteResult = { id: string; added: boolean; published: boolean; replaces?: string };

/**
 * What creating a course did: `added`, false for the one already under its
 * key; and whether it is `published`, as it stands (ADR 0039).
 */
export type CourseWriteResult = { courseId: string; added: boolean; published: boolean };
