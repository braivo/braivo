// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  Activity,
  AuthoredCourse,
  AuthoredTask,
  Connection,
  Course,
  CourseProgressOverview,
  DomainClaim,
  DomainList,
  Draft,
  Grade,
  GradedEvidence,
  Group,
  GroupChange,
  GroupDefinition,
  Handoff,
  HostOrganization,
  LearnerProgressReport,
  LearnerProgressSummary,
  LocatedCitation,
  ManagedCourse,
  Member,
  Objective,
  Organization,
  OrganizationSetup,
  QuotedCitation,
  SessionUser,
  SignInSettings,
  Source,
  SourceRange,
  SourceSlice,
  SourceSummary,
  TaskDraft,
  TaskResponse,
} from "./types.ts";

// The client for Braivo's HTTP API, which the learn and console apps import as
// `@braivo/server/client` and `braivo` (packages/cli) uses to reach a remote
// installation. It is bundled into the apps, so it may import nothing from the
// server but types and modules importing nothing themselves,
// `content/course-ref.ts` and `application/learner-day.ts` (`client.test.ts`
// checks).
//
// It covers what its callers call, not the whole API: an authoring route with
// no method here is one no screen or command uses. Add one in the commit whose
// caller needs it.

export type {
  Activity,
  AuthoredCourse,
  AuthoredTask,
  Connection,
  Course,
  CourseProgressOverview,
  Domain,
  DomainClaim,
  DomainList,
  Draft,
  Grade,
  GradedEvidence,
  Group,
  GroupChange,
  GroupDefinition,
  Handoff,
  HostOrganization,
  LearnerProgressReport,
  LearnerProgressSummary,
  LearningDecision,
  LocatedCitation,
  ManagedCourse,
  Member,
  Objective,
  LearnerProgressStanding,
  Organization,
  OrganizationSetup,
  Passage,
  QuotedCitation,
  SessionUser,
  SignInSettings,
  Source,
  SourceRange,
  SourceSlice,
  SourceSummary,
  TaskDraft,
  TaskResponse,
} from "./types.ts";
export { courseRef, isUrlLabel, parseCourseRef, urlLabel } from "../content/course-ref.ts";
export { learnerDayIn } from "../application/learner-day.ts";

/**
 * An answer the client could not use: a refusal, a status the method does not
 * expect from that endpoint, or a body that is not JSON. Not a request that got
 * no answer — a network failure or a cancellation rejects as `fetch` does.
 */
export class BraivoError extends Error {
  readonly status: number;
  /**
   * Braivo's own explanation, when the answer carried one: which citation it
   * refused and why, say. Meant to be shown, to a person or a model, as it is.
   */
  readonly reason: string | undefined;
  /**
   * Braivo's code for the refusal, where it answers one (`ADDRESS_TAKEN`,
   * say), for a client to word it in its own language rather than show
   * `reason`, which is English (ADR 0035).
   */
  readonly code: string | undefined;

  constructor(status: number, message: string, reason?: string, code?: string) {
    super(message);
    this.name = "BraivoError";
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

export type ClientOptions = {
  /**
   * Injected so that a test, or a runtime with its own configured fetch, can
   * supply one. Defaults to the global.
   */
  fetch?: typeof globalThis.fetch;
};

export type RequestOptions = {
  /**
   * Sent with the request. The session cookie is not among them: a browser
   * carries it by itself, and Braivo takes who is asking from it rather than
   * from anything the caller names.
   */
  headers?: RequestInit["headers"];
  signal?: AbortSignal;
};

export type BraivoClient = {
  /**
   * The organization the app's own domain serves, which it is branded as, or
   * `undefined` when the domain serves none — an installation reached at its
   * own address, say. Needs no session.
   */
  hostOrganization(options?: RequestOptions): Promise<HostOrganization | undefined>;

  /**
   * Who is signed in on this host, or `undefined` when no one is: on a learn
   * domain its learner session's user, on the installation's the account's.
   */
  session(options?: RequestOptions): Promise<SessionUser | undefined>;

  /** Signs out of this host alone: a learn domain's learner session, or the account. */
  signOut(options?: RequestOptions): Promise<void>;

  /** What `/login` offers besides an emailed code, on the installation's host or a learn domain's. */
  signInSettings(options?: RequestOptions): Promise<SignInSettings>;

  /**
   * On a learn domain, emails `email` a code that signs in there alone (ADR
   * 0018), in the language the request's `Accept-Language` prefers. A
   * {@link BraivoError} with its `code`: 429 `SIGN_IN_CODE_COOLDOWN` within
   * a minute of the last, 503 `SIGN_IN_CODE_SEND_FAILED`; 429 without one, too
   * many requests from this client.
   */
  sendSignInCode(email: string, options?: RequestOptions): Promise<void>;

  /**
   * On a learn domain, signs `email` in there with the code it sent, as its
   * learner, resolving to who is signed in, whose name may still be empty. A
   * {@link BraivoError} with its `code`: 400 `INVALID_OTP` or `OTP_EXPIRED`,
   * 403 `TOO_MANY_ATTEMPTS`, or 403 `NOT_A_MEMBER`, after which the code
   * still works once the account is added.
   */
  signInWithCode(email: string, code: string, options?: RequestOptions): Promise<SessionUser>;

  /**
   * On a learn domain, names the signed-in learner's account, which has no
   * name yet. A {@link BraivoError}: 401 signed out, 400 `NAME_INVALID`, 409
   * `ALREADY_NAMED`.
   */
  nameAccount(name: string, options?: RequestOptions): Promise<void>;

  /**
   * What a learn domain's sign-in, `handoffId`, signs in to, or `undefined`
   * once it expired. Needs no session.
   */
  handoff(handoffId: string, options?: RequestOptions): Promise<Handoff | undefined>;

  /**
   * Hands the signed-in account over to the learn domain `handoffId` began on,
   * resolving to the URL to navigate to, within a minute. A
   * {@link BraivoError}: 401 signed out meanwhile, 403 not a member of its
   * organization, 404 expired.
   */
  completeHandoff(handoffId: string, options?: RequestOptions): Promise<string>;

  /**
   * What the signed-in learner should do next in a course — the decision, its
   * objective, and a task to practise it unless the objective has none; the
   * objective while its tasks rest; or the daily limit on new objectives, once
   * reached with nothing else to do — or `undefined` when they are caught up.
   * Days are counted in this runtime's time zone, a browser's being its user's. A
   * course that does not exist and one this learner may not see are both a
   * {@link BraivoError} with status 404, deliberately indistinguishable.
   */
  nextActivity(courseId: string, options?: RequestOptions): Promise<Activity | undefined>;

  /**
   * Answers a task as the signed-in learner, and resolves to Braivo's grade.
   * `id` names the attempt and is the caller's to generate, once per attempt:
   * resending the same attempt after a lost answer records nothing twice and
   * resolves to the same grade, while reusing `id` in the course's organization
   * for another answer, or
   * answering a task that is resting, is a {@link BraivoError} with status 409:
   * ask for the activity again. Other refusals, by status: 401 no session;
   * 404 course or task missing, retired, or not this learner's; 400 a
   * response that cannot answer the task; 403 possibly forged; 413 body over
   * 1 MB.
   */
  submitAttempt(
    input: { courseId: string; id: string; taskId: string; response: TaskResponse },
    options?: RequestOptions,
  ): Promise<Grade>;

  /**
   * Where a learner stands on each objective in a course, for the learner, a
   * content owner, or a teacher. The session must be the learner's, hold
   * `owner` or `admin` in the course's organization, or teach a group the
   * learner is in that takes the course; the learner must belong to it.
   *
   * A missing course, a session that may not read it, and a learner outside the
   * organization are one {@link BraivoError} with status 404, which of the
   * three it was being exactly what Braivo declines to say.
   */
  learnerProgress(
    input: { courseId: string; learnerId: string; includeHistory?: true },
    options?: RequestOptions,
  ): Promise<LearnerProgressReport>;
  /** Without each objective's evidence, which grows with every result: standings only. */
  learnerProgress(
    input: { courseId: string; learnerId: string; includeHistory: false },
    options?: RequestOptions,
  ): Promise<LearnerProgressSummary>;

  /**
   * Where each learner in a course stands, counted, by name: every member of
   * its organization, with their roles, for a session holding `owner` or
   * `admin` there; for a teacher, without roles, the learners of the groups
   * they teach that take the course. `published` says whether those learners
   * reach it yet.
   *
   * A missing course and one the session may not read are one
   * {@link BraivoError} with status 404.
   */
  courseProgress(courseId: string, options?: RequestOptions): Promise<CourseProgressOverview>;

  /**
   * The courses the signed-in learner may study, by title: every course of
   * every organization they belong to, and on an organization's domain only
   * that one's.
   */
  learnerCourses(options?: RequestOptions): Promise<Course[]>;

  /**
   * The signed-in learner's course numbered `number` on this organization's
   * domain, or `undefined` when they have none so numbered, as on the
   * installation's host, where a number names no course.
   */
  learnerCourseByNumber(number: number, options?: RequestOptions): Promise<Course | undefined>;

  /**
   * The organizations the session's user works in, by name: those where they
   * hold `owner` or `admin`, and those where they teach a group, told apart by
   * `administers`. Not every one they are in, since a learner is a member too.
   */
  listOrganizations(options?: RequestOptions): Promise<Organization[]>;

  /**
   * Setting up an organization here: its domain, as `<slug>.<domain>`, and
   * data regions (ADR 0040); `null` where the operator creates every one.
   */
  organizationSetup(options?: RequestOptions): Promise<OrganizationSetup | null>;

  /**
   * Sets up an organization the session's user owns, served at
   * `<slug>.<domain>` (ADR 0018). A {@link BraivoError} whose `reason` is
   * meant for them: 400 a name or address that cannot be one, 409 an address
   * taken or an organization already owned; 404 where the operator creates them.
   */
  setUpOrganization(
    organization: { name: string; slug: string },
    options?: RequestOptions,
  ): Promise<Organization>;

  /**
   * Renames an organization, answering the name as stored, trimmed. A
   * {@link BraivoError} with `code` `NAME_INVALID` (400) for one blank, over
   * 100 characters, or holding NUL; 403 without `owner` or `admin` there.
   */
  renameOrganization(
    organizationId: string,
    name: string,
    options?: RequestOptions,
  ): Promise<{ name: string }>;

  /**
   * Every member of an organization, by name, without their emails.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listMembers(organizationId: string, options?: RequestOptions): Promise<Member[]>;

  /**
   * The AI apps the signed-in person connected (ADR 0045), one per app and
   * organization. A browser's session alone: a token gets a
   * {@link BraivoError} with status 403.
   */
  listConnections(options?: RequestOptions): Promise<Connection[]>;

  /**
   * Ends one of the signed-in person's connections, by its `id`: its app's
   * next call is refused, and it must ask for consent again. A
   * {@link BraivoError} with status 404 when they have none by that ID.
   */
  disconnectConnection(connectionId: string, options?: RequestOptions): Promise<void>;

  /**
   * An organization's groups, by name: every one to a session holding `owner`
   * or `admin` there, and to any other member those they teach, whose
   * progress in which courses they may read (ADR 0042). Anyone else gets a
   * {@link BraivoError} with status 403.
   */
  listGroups(organizationId: string, options?: RequestOptions): Promise<Group[]>;

  /**
   * Creates a group of the organization's members taking some of its courses,
   * and resolves to its ID. Its teachers then read its learners' progress in
   * its courses; who may study a course is unchanged. With a `key`, the same
   * group created again resolves to the same ID, and another under it is a
   * 409. A name Braivo will not store, an ID listed twice, a person in both
   * roles, someone who is not a member, or a course not the organization's is
   * a 400 whose `reason` says which.
   */
  defineGroup(
    input: { organizationId: string; key?: string } & GroupDefinition,
    options?: RequestOptions,
  ): Promise<string>;

  /**
   * Changes a group, naming only what changes, and resolves to the group as
   * it then stands. Removals apply first, so removing someone and adding them
   * in one change sets their role; adding someone already there in the other
   * role is a {@link BraivoError} with status 409, never a silent promotion.
   * Adding what is there, or removing what is not, does nothing. A change
   * naming nothing is a 400; a group the organization does not have, 404;
   * refusals otherwise as `defineGroup`.
   */
  changeGroup(
    input: { organizationId: string; groupId: string } & GroupChange,
    options?: RequestOptions,
  ): Promise<Group>;

  /**
   * The hostnames serving an organization's learn app, newest first: the
   * first is the one its learn domain is named by (`Organization.learnDomain`).
   * Then those it claimed, with where each stands, and whether a new one can
   * be added here.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listDomains(organizationId: string, options?: RequestOptions): Promise<DomainList>;

  /**
   * Claims `hostname` for an organization, answering the DNS records that
   * point it here and prove it theirs; it serves once activated (ADR 0038).
   * Claiming it again answers again. A {@link BraivoError} whose `code` says
   * why: 400 `DOMAIN_INVALID` or `DOMAIN_RESERVED`, 409 `DOMAIN_TAKEN` or
   * `ALREADY_ADDED`, 502 `PROVISIONING_FAILED`, which may pass on a retry;
   * 403 without `owner` or `admin` there; 501 where domains cannot be added.
   */
  claimDomain(
    organizationId: string,
    hostname: string,
    options?: RequestOptions,
  ): Promise<DomainClaim>;

  /**
   * Makes a claimed hostname serve the organization's learn app, as its
   * primary domain, once ready (ADR 0038); one serving it already succeeds
   * too, left as it is. A {@link BraivoError} whose `code` says why not: 409
   * `NOT_VERIFIED` while not ready, 404 for a hostname not claimed, 502
   * `PROVISIONING_FAILED`, which may pass on a retry; 403 without `owner` or
   * `admin` there; 501 where domains cannot be added.
   */
  activateDomain(organizationId: string, hostname: string, options?: RequestOptions): Promise<void>;

  /**
   * Removes a domain serving an organization, or its claim to one: it stops
   * serving at once. A {@link BraivoError} says why not: 409, its `code`
   * `DOMAIN_RESERVED` for the installation's own, `LAST_DOMAIN` for the only
   * one serving; 404 for a hostname the organization does not hold; 403 without
   * `owner` or `admin` there; 501 where domains cannot be removed.
   */
  removeDomain(organizationId: string, hostname: string, options?: RequestOptions): Promise<void>;

  /**
   * Every course an organization has, by title.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listCourses(organizationId: string, options?: RequestOptions): Promise<ManagedCourse[]>;

  /**
   * Publishes what a person reviewed, the organization's courses `courseIds`
   * and tasks `taskIds`, all or none, so learners reach them (ADR 0039). Only
   * from a browser: a tool's token is refused, 403. A course the organization
   * has not, or a task retired or corrected since, fails it all, a
   * {@link BraivoError} with status 409: reload and publish what is shown;
   * another organization's task, 403.
   */
  publish(
    input: { organizationId: string; courseIds?: string[]; taskIds?: string[] },
    options?: RequestOptions,
  ): Promise<void>;

  /**
   * Every objective an organization has registered, by title — a listing
   * order, not the order a course teaches them in — so an agent can reuse an
   * objective rather than define it twice.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listObjectives(organizationId: string, options?: RequestOptions): Promise<Objective[]>;

  /**
   * Records what a learner did, on behalf of an organization. The session must
   * hold `owner` or `admin` there: grading is a content owner's act, and a
   * learner able to grade themselves would be writing the history their own
   * estimates are rebuilt from. An empty `evidence` records nothing and checks
   * no permission.
   *
   * Redelivering a result is a no-op, so retrying after a timeout is safe. One
   * that disagrees with what its `id` already holds in that organization is a
   * {@link BraivoError} with status 409, and nothing in that batch is stored.
   */
  recordEvidence(
    input: {
      organizationId: string;
      learnerId: string;
      evidence: readonly GradedEvidence[];
    },
    options?: RequestOptions,
  ): Promise<void>;

  /**
   * Adds material to an organization, as text — a document's, or a video's
   * transcript — and resolves to the new source's ID. `url` is where the text
   * came from when that is a link, `language` its main language as a BCP 47
   * tag. A source is never edited: adding a revision adds another, while adding
   * one already there resolves to its ID, so a retry is safe.
   *
   * The session must hold `owner` or `admin` there, or this throws a
   * {@link BraivoError} with status 403; text or a link Braivo cannot store is
   * one with status 400.
   */
  addSource(
    input: {
      organizationId: string;
      title: string;
      url?: string;
      language?: string;
      /** The `fileId` {@link BraivoClient.uploadFile} resolved to for the file the text is from. */
      original?: string;
    } & (
      | { text: string }
      /**
       * A recording's captions instead of text, in order: Braivo joins them
       * into the source's text, one per line, and keeps when each is said, so
       * a passage cited from it names its moment.
       */
      | { cues: readonly { at: number; text: string }[] }
      /**
       * A document's pages instead of text, each labelled as printed: Braivo
       * joins them into the source's text, a blank line apart, and keeps where
       * each begins, so a passage cited from it names its page.
       */
      | { pages: readonly { page: string; text: string }[] }
    ),
    options?: RequestOptions,
  ): Promise<string>;

  /**
   * Keeps a file in an organization — the PDF a source's text was extracted
   * from, say — and resolves to its `fileId`, the SHA-256 of its bytes, which
   * `addSource` takes as `original`. The blob's `type` is what it is kept as,
   * so it must have one; uploading the same bytes again resolves to the same
   * ID. At most 50 MB. An installation that keeps no files answers 501.
   */
  uploadFile(
    input: { organizationId: string; file: Blob },
    options?: RequestOptions,
  ): Promise<{ fileId: string; contentType: string; size: number }>;

  /**
   * Every source an organization has, by title and without its text. 403
   * unless the session administers it.
   */
  listSources(organizationId: string, options?: RequestOptions): Promise<SourceSummary[]>;

  /**
   * One source, text included. A source the organization does not have is a
   * {@link BraivoError} with status 404; one the session may not read, 403.
   */
  getSource(
    input: { organizationId: string; sourceId: string },
    options?: RequestOptions,
  ): Promise<Source>;

  /**
   * A bounded part of a source: at most 20,000 characters of its text, from
   * where `range` asks (the start when it asks nothing), and `next`, the range
   * to ask next, while what was asked runs on. A range the source cannot
   * answer — page 40 of 30, pages of a text without them — is a
   * {@link BraivoError} with status 400 whose `reason` says which it can.
   */
  getSourceSlice(
    input: { organizationId: string; sourceId: string } & SourceRange,
    options?: RequestOptions,
  ): Promise<SourceSlice>;

  /**
   * Registers learning targets and resolves to their IDs, in the order given.
   * `key` is the caller's own name for one, unique within the organization:
   * sent again with the same title it resolves to the same ID, so a retry adds
   * nothing, and with another title it is a {@link BraivoError} with status 409
   * whose `reason` says so. A title or key Braivo will not store is a 400 whose
   * `reason` names the objective. 403 unless the session administers the
   * organization.
   */
  defineObjectives(
    input: { organizationId: string; objectives: readonly { title: string; key?: string }[] },
    options?: RequestOptions,
  ): Promise<string[]>;

  /**
   * Links objectives to the passages of sources that teach them, and resolves
   * to where Braivo found each quote. All or nothing: a quote Braivo cannot
   * find, or finds twice, is a {@link BraivoError} with status 400 whose
   * `reason` names the citation and says why.
   */
  citeSources(
    input: { organizationId: string; citations: readonly QuotedCitation[] },
    options?: RequestOptions,
  ): Promise<LocatedCitation[]>;

  /**
   * Adds tasks, each with the passages it was written from, and resolves to
   * their IDs in the order given. A task already there, unretired, resolves to
   * its ID instead, so a retry is safe. All or nothing; a quote Braivo cannot
   * cite is a 400 whose `reason` names the task and citation.
   *
   * A task naming one it `replaces`, sent alone for the same objective, is its
   * correction: that task is retired with it. Repeating one is safe; a 409
   * means someone changed the task first, or, coded `DUPLICATE_CORRECTION`,
   * that another task is the same.
   *
   * Added with a tool's token, a task waits until its owner publishes it in
   * Braivo's console; a correction keeps the state of the task it replaces,
   * and a tool's of a task once published is a 403 whose `reason` says so.
   */
  defineTasks(
    input: { organizationId: string; tasks: readonly TaskDraft[] },
    options?: RequestOptions,
  ): Promise<string[]>;

  /**
   * An objective's unretired tasks, published or waiting, oldest first, as
   * authored — answers included — with the passages each cites. An objective
   * the organization does not have is a {@link BraivoError} with status 404;
   * one the session may not administer, 403.
   */
  listTasks(
    input: { organizationId: string; objectiveId: string },
    options?: RequestOptions,
  ): Promise<AuthoredTask[]>;

  /**
   * One course as authored — objectives in order, each with its passages and
   * tasks — for reviewing it whole. A course the organization does not have is
   * a {@link BraivoError} with status 404; one the session may not
   * administer, 403.
   */
  readCourse(
    input: { organizationId: string; courseId: string },
    options?: RequestOptions,
  ): Promise<AuthoredCourse>;

  /**
   * Sets what follows a course's number in its learners' links, replacing
   * `previous`, the label read; a label as `urlLabel` writes one, else 400.
   * Not saved, with the label now, when someone else changed it meanwhile. A
   * course the organization does not have is a {@link BraivoError} with
   * status 404; one the session may not administer, 403.
   */
  setCourseUrlLabel(
    input: { organizationId: string; courseId: string; urlLabel: string; previous: string },
    options?: RequestOptions,
  ): Promise<{ saved: true } | { saved: false; urlLabel: string }>;

  /**
   * Drafts a course from a source with the installation's own model, for
   * review: nothing is stored until its objectives, citations, and tasks are
   * authored. Slow — the model reads the whole source. An installation with no
   * model answers 501, an organization its operator has not let draft 403, one
   * past its monthly AI limit 429, and a model that fails 502, each with a
   * `reason`.
   */
  draftCourse(
    input: { organizationId: string; sourceId: string; audience?: string },
    options?: RequestOptions,
  ): Promise<Draft>;

  /**
   * One of an organization's files — a PDF, a photo of a page — read into text
   * page by page by the installation's model, for `addSource` as `pages` with
   * the file as `original`. Nothing is stored. Slow, as drafting is, and
   * refused with a `reason` as drafting is; a file that is not a PDF or an
   * image, or too large, is a 400.
   */
  readFileText(
    input: { organizationId: string; fileId: string },
    options?: RequestOptions,
  ): Promise<{ page: string; text: string }[]>;

  /**
   * Authors the part of a draft a content owner kept — its objectives, their
   * citations, their tasks — and a course over them, and resolves to the
   * course's ID (ADR 0029). Every step is safe to repeat: objectives by the
   * keys the draft made, citations and tasks by what they are, the course by a
   * key derived from its title and objectives. So after a failure halfway,
   * sending the same again finishes the course rather than duplicating it; a
   * refusal is the failing step's {@link BraivoError}.
   */
  acceptDraft(
    input: {
      organizationId: string;
      sourceId: string;
      title: string;
      objectives: Draft["objectives"];
    },
    options?: RequestOptions,
  ): Promise<string>;

  /**
   * Withdraws tasks from practice: never offered or answered again, their
   * evidence kept. To correct one instead, add its correction with `replaces`.
   * All or nothing: a task not the organization's is a {@link BraivoError}
   * with status 403, as is one once published, retired with a tool's token,
   * whose `reason` says why.
   */
  retireTasks(
    input: { organizationId: string; taskIds: readonly string[] },
    options?: RequestOptions,
  ): Promise<void>;

  /**
   * Creates a course over existing objectives, in the order learners meet them,
   * and resolves to its ID. With a `key`, sending the same course again —
   * title and objectives in the same order — resolves to the same ID, and
   * sending another under it is a {@link BraivoError} with status 409. A title
   * or key Braivo will not store, or an objective listed twice, is a 400 whose
   * `reason` says which.
   */
  defineCourse(
    input: {
      organizationId: string;
      title: string;
      objectiveIds: readonly string[];
      key?: string;
    },
    options?: RequestOptions,
  ): Promise<string>;
};

/**
 * A client for the endpoints above. Paths are relative, so an app's requests go
 * to the origin it is served from — the only one that works, since Braivo
 * serves `/api` from every origin that serves an app (ADR 0004) and sends no
 * CORS headers. A caller elsewhere, the CLI, resolves them in its `fetch`.
 */
export function createClient(options: ClientOptions = {}): BraivoClient {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);

  /** Every read: a GET carrying the session. */
  function get(path: string, requestOptions: RequestOptions | undefined) {
    return request(path, {
      method: "GET",
      // Same-origin already sends the cookie, but stated rather than left to
      // the default, since the session is what every one of these depends on.
      credentials: "include",
      headers: requestOptions?.headers,
      signal: requestOptions?.signal,
    });
  }

  /** Every write: JSON, carrying the session. */
  function post(path: string, body: unknown, requestOptions: RequestOptions | undefined) {
    // Built, not spread: spreading drops a `Headers` or an array. The content
    // type is set last, not the caller's to override: Braivo requires it
    // because a browser cannot send it cross-origin without a preflight.
    const headers = new Headers(requestOptions?.headers);
    headers.set("content-type", "application/json");

    return request(path, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
      signal: requestOptions?.signal,
    });
  }

  /**
   * The error for a status a method was not written for. Each accepts exactly
   * what its endpoint answers with, never "any 2xx": a 202 from something in
   * between would otherwise be parsed as though it were a real answer.
   */
  async function unexpected(response: Response, doing: string): Promise<BraivoError> {
    const { reason, code } = await explanation(response);
    return new BraivoError(
      response.status,
      `Braivo answered ${response.status} ${doing}${reason ? `: ${reason}` : "."}`,
      reason,
      code,
    );
  }

  /**
   * A body as JSON, or a {@link BraivoError} when it is not — an empty 200, or
   * an HTML page something in between put there, which unconverted would reach
   * the caller as a `SyntaxError` carrying no status.
   *
   * Read to text first, then parsed, so that the only error caught here is one
   * this function raised: a dropped connection or the caller's cancellation
   * rejects out of `text()` untouched, where `response.json()` would raise
   * either from the same call.
   *
   * Only that it parses, never its shape — that is Braivo's contract, held by
   * the server's tests and by the contract test that drives this against them.
   */
  async function parsed<T>(response: Response, doing: string): Promise<T> {
    const body = await response.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new BraivoError(
        response.status,
        `Braivo answered ${response.status} with a body that is not JSON, ${doing}.`,
      );
    }
  }

  const client: BraivoClient = {
    async hostOrganization(requestOptions) {
      const response = await get("/api/organization", requestOptions);

      const doing = "asking which organization this domain serves";
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<HostOrganization>(response, doing);
    },

    async session(requestOptions) {
      const response = await get("/api/session", requestOptions);

      const doing = "asking who is signed in";
      if (response.status === 401) return undefined;
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ user: SessionUser }>(response, doing)).user;
    },

    async signOut(requestOptions) {
      const response = await post("/api/session/sign-out", {}, requestOptions);
      if (response.status !== 204) throw await unexpected(response, "signing out");
    },

    async signInSettings(requestOptions) {
      const response = await get("/api/sign-in-settings", requestOptions);

      const doing = "asking what sign-in offers";
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<SignInSettings>(response, doing);
    },

    async sendSignInCode(email, requestOptions) {
      const response = await post("/api/session/code", { email }, requestOptions);
      if (response.status !== 204) throw await unexpected(response, "sending a sign-in code");
    },

    async signInWithCode(email, code, requestOptions) {
      const response = await post("/api/session/sign-in", { email, code }, requestOptions);

      const doing = "signing in with a code";
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ user: SessionUser }>(response, doing)).user;
    },

    async nameAccount(name, requestOptions) {
      const response = await post("/api/session/name", { name }, requestOptions);
      if (response.status !== 204) throw await unexpected(response, "naming the account");
    },

    async handoff(handoffId, requestOptions) {
      const response = await get(`/api/handoffs/${encodeURIComponent(handoffId)}`, requestOptions);

      const doing = "reading what this sign-in is for";
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<Handoff>(response, doing);
    },

    async completeHandoff(handoffId, requestOptions) {
      const response = await post(
        `/api/handoffs/${encodeURIComponent(handoffId)}`,
        {},
        requestOptions,
      );

      const doing = "handing this sign-in over";
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ url: string }>(response, doing)).url;
    },

    async nextActivity(courseId, requestOptions) {
      const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
      const response = await get(
        `/api/courses/${encodeURIComponent(courseId)}/activity?${new URLSearchParams({ timeZone })}`,
        requestOptions,
      );

      // Caught up. A missing course, or one not this learner's, is a 404 and
      // throws below.
      const doing = `asking what is next in course "${courseId}"`;
      if (response.status === 204) return undefined;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<Activity>(response, doing);
    },

    async submitAttempt(input, requestOptions) {
      const { courseId, ...attempt } = input;
      const response = await post(
        `/api/courses/${encodeURIComponent(courseId)}/attempts`,
        attempt,
        requestOptions,
      );

      const doing = `answering task "${input.taskId}" in course "${courseId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<Grade>(response, doing);
    },

    async learnerProgress(
      input: { courseId: string; learnerId: string; includeHistory?: boolean },
      requestOptions?: RequestOptions,
    ) {
      const response = await get(
        `/api/courses/${encodeURIComponent(input.courseId)}` +
          `/learners/${encodeURIComponent(input.learnerId)}/progress` +
          (input.includeHistory === false ? "?includeHistory=false" : ""),
        requestOptions,
      );

      const doing = `reading the progress of learner "${input.learnerId}" in course "${input.courseId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<LearnerProgressReport>(response, doing);
    },

    async courseProgress(courseId, requestOptions) {
      const response = await get(
        `/api/courses/${encodeURIComponent(courseId)}/progress`,
        requestOptions,
      );

      const doing = `reading the progress of course "${courseId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<CourseProgressOverview>(response, doing);
    },

    async learnerCourses(requestOptions) {
      const response = await get("/api/courses", requestOptions);

      const doing = "listing the learner's courses";
      if (response.status !== 200) throw await unexpected(response, doing);

      const { courses } = await parsed<{ courses: Course[] }>(response, doing);
      return courses;
    },

    async learnerCourseByNumber(number, requestOptions) {
      const response = await get(
        `/api/courses?${new URLSearchParams({ number: String(number) })}`,
        requestOptions,
      );

      const doing = `finding the learner's course ${number}`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { courses } = await parsed<{ courses: Course[] }>(response, doing);
      return courses[0];
    },

    async listOrganizations(requestOptions) {
      const response = await get("/api/organizations", requestOptions);

      const doing = "listing the organizations you work in";
      if (response.status !== 200) throw await unexpected(response, doing);

      const { organizations } = await parsed<{
        organizations: (Omit<Organization, "administers"> & { administers?: boolean })[];
      }>(response, doing);
      // A server from before teachers were listed answers managed ones alone,
      // without `administers`: each of those is administered.
      return organizations.map((organization) => ({
        ...organization,
        administers: organization.administers ?? true,
      }));
    },

    async organizationSetup(requestOptions) {
      const response = await get("/api/organization-setup", requestOptions);

      const doing = "asking whether an organization may be set up";
      if (response.status !== 200) throw await unexpected(response, doing);

      const { domain, ...rest } = await parsed<
        Omit<OrganizationSetup, "domain"> & { domain: string | null }
      >(response, doing);
      return domain === null ? null : { domain, ...rest };
    },

    async setUpOrganization(organization, requestOptions) {
      const response = await post("/api/organization-setup", organization, requestOptions);

      const doing = "setting up an organization";
      if (response.status !== 201) throw await unexpected(response, doing);

      return (await parsed<{ organization: Organization }>(response, doing)).organization;
    },

    async renameOrganization(organizationId, name, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/rename`,
        { name },
        requestOptions,
      );

      const doing = `renaming organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<{ name: string }>(response, doing);
    },

    async listMembers(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/members`,
        requestOptions,
      );

      const doing = `listing the members of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { members } = await parsed<{ members: Member[] }>(response, doing);
      return members;
    },

    async listConnections(requestOptions) {
      const response = await get("/api/connections", requestOptions);

      const doing = "listing connected apps";
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ connections: Connection[] }>(response, doing)).connections;
    },

    async disconnectConnection(connectionId, requestOptions) {
      const response = await post(
        `/api/connections/${encodeURIComponent(connectionId)}/disconnect`,
        {},
        requestOptions,
      );
      if (response.status !== 204) {
        throw await unexpected(response, `disconnecting connection "${connectionId}"`);
      }
    },

    async listGroups(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/groups`,
        requestOptions,
      );

      const doing = `listing the groups of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ groups: Group[] }>(response, doing)).groups;
    },

    async defineGroup({ organizationId, ...group }, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/groups`,
        group,
        requestOptions,
      );

      const doing = `creating group "${group.name}" in organization "${organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      return (await parsed<{ groupId: string }>(response, doing)).groupId;
    },

    async changeGroup({ organizationId, groupId, ...change }, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}`,
        change,
        requestOptions,
      );

      const doing = `changing group "${groupId}" of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return (await parsed<{ group: Group }>(response, doing)).group;
    },

    async listDomains(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/domains`,
        requestOptions,
      );

      const doing = `listing the domains of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<DomainList>(response, doing);
    },

    async claimDomain(organizationId, hostname, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/domains`,
        { hostname },
        requestOptions,
      );

      const doing = `claiming ${hostname} for organization "${organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      return (await parsed<{ claim: DomainClaim }>(response, doing)).claim;
    },

    async activateDomain(organizationId, hostname, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/domains/${encodeURIComponent(hostname)}/activate`,
        {},
        requestOptions,
      );

      const doing = `activating ${hostname} for organization "${organizationId}"`;
      if (response.status !== 204) throw await unexpected(response, doing);
    },

    async removeDomain(organizationId, hostname, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/domains/${encodeURIComponent(hostname)}/remove`,
        {},
        requestOptions,
      );

      const doing = `removing ${hostname} from organization "${organizationId}"`;
      if (response.status !== 204) throw await unexpected(response, doing);
    },

    async listCourses(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/courses`,
        requestOptions,
      );

      const doing = `listing the courses of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { courses } = await parsed<{ courses: ManagedCourse[] }>(response, doing);
      return courses;
    },

    async publish({ organizationId, courseIds = [], taskIds = [] }, requestOptions) {
      const response = await post(
        `${organizationPath(organizationId)}/publish`,
        { courseIds, taskIds },
        requestOptions,
      );

      const doing = `publishing in organization "${organizationId}"`;
      if (response.status !== 204) throw await unexpected(response, doing);
    },

    async listObjectives(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/objectives`,
        requestOptions,
      );

      const doing = `listing the objectives of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { objectives } = await parsed<{ objectives: Objective[] }>(response, doing);
      return objectives;
    },

    async recordEvidence(input, requestOptions) {
      const response = await post(
        `/api/organizations/${encodeURIComponent(input.organizationId)}` +
          `/learners/${encodeURIComponent(input.learnerId)}/evidence`,
        { evidence: input.evidence },
        requestOptions,
      );

      if (response.status === 204) return;
      throw await unexpected(response, `recording evidence for learner "${input.learnerId}"`);
    },

    async addSource(input, requestOptions) {
      const { organizationId, ...source } = input;
      const response = await post(
        `/api/organizations/${encodeURIComponent(organizationId)}/sources`,
        source,
        requestOptions,
      );

      const doing = `adding source "${input.title}" to organization "${organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      const { sourceId } = await parsed<{ sourceId: string }>(response, doing);
      return sourceId;
    },

    async uploadFile({ organizationId, file }, requestOptions) {
      // As `post` does for JSON, except that the type is the file's own.
      const headers = new Headers(requestOptions?.headers);
      headers.set("content-type", file.type);
      const response = await request(`${organizationPath(organizationId)}/files`, {
        method: "POST",
        credentials: "include",
        headers,
        body: file,
        signal: requestOptions?.signal,
      });

      const doing = `uploading a file to organization "${organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      return parsed<{ fileId: string; contentType: string; size: number }>(response, doing);
    },

    async listSources(organizationId, requestOptions) {
      const response = await get(`${organizationPath(organizationId)}/sources`, requestOptions);

      const doing = `listing the sources of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { sources } = await parsed<{ sources: SourceSummary[] }>(response, doing);
      return sources;
    },

    async getSource(input, requestOptions) {
      const response = await get(
        `${organizationPath(input.organizationId)}/sources/${encodeURIComponent(input.sourceId)}`,
        requestOptions,
      );

      const doing = `reading source "${input.sourceId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<Source>(response, doing);
    },

    async getSourceSlice({ organizationId, sourceId, ...range }, requestOptions) {
      const query = new URLSearchParams(
        Object.entries(range).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      if (query.size === 0) query.set("characters", "0-");
      const response = await get(
        `${organizationPath(organizationId)}/sources/${encodeURIComponent(sourceId)}?${query}`,
        requestOptions,
      );

      const doing = `reading source "${sourceId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<SourceSlice>(response, doing);
    },

    async defineObjectives(input, requestOptions) {
      const response = await post(
        `${organizationPath(input.organizationId)}/objectives`,
        { objectives: input.objectives },
        requestOptions,
      );

      const doing = `defining objectives in organization "${input.organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      const { objectiveIds } = await parsed<{ objectiveIds: string[] }>(response, doing);
      return objectiveIds;
    },

    async citeSources(input, requestOptions) {
      const response = await post(
        `${organizationPath(input.organizationId)}/citations`,
        { citations: input.citations },
        requestOptions,
      );

      const doing = `citing sources in organization "${input.organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { citations } = await parsed<{ citations: LocatedCitation[] }>(response, doing);
      return citations;
    },

    async defineTasks(input, requestOptions) {
      const response = await post(
        `${organizationPath(input.organizationId)}/tasks`,
        { tasks: input.tasks },
        requestOptions,
      );

      const doing = `adding tasks in organization "${input.organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      const { taskIds } = await parsed<{ taskIds: string[] }>(response, doing);
      return taskIds;
    },

    async listTasks({ organizationId, objectiveId }, requestOptions) {
      const response = await get(
        `${organizationPath(organizationId)}/objectives/${encodeURIComponent(objectiveId)}/tasks`,
        requestOptions,
      );

      const doing = `listing the tasks of objective "${objectiveId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { tasks } = await parsed<{ tasks: AuthoredTask[] }>(response, doing);
      return tasks;
    },

    async readCourse({ organizationId, courseId }, requestOptions) {
      const response = await get(
        `${organizationPath(organizationId)}/courses/${encodeURIComponent(courseId)}`,
        requestOptions,
      );

      const doing = `reading course "${courseId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<AuthoredCourse>(response, doing);
    },

    async setCourseUrlLabel({ organizationId, courseId, urlLabel, previous }, requestOptions) {
      const response = await post(
        `${organizationPath(organizationId)}/courses/${encodeURIComponent(courseId)}/url-label`,
        { urlLabel, previous },
        requestOptions,
      );

      const doing = `changing the URL label of course "${courseId}"`;
      if (response.status === 409) {
        const { urlLabel: now } = await parsed<{ urlLabel: string }>(response, doing);
        return { saved: false, urlLabel: now };
      }
      if (response.status !== 204) throw await unexpected(response, doing);
      return { saved: true };
    },

    async draftCourse({ organizationId, sourceId, audience }, requestOptions) {
      const response = await post(
        `${organizationPath(organizationId)}/sources/${encodeURIComponent(sourceId)}/draft`,
        { audience },
        requestOptions,
      );

      const doing = `drafting a course from source "${sourceId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<Draft>(response, doing);
    },

    async readFileText({ organizationId, fileId }, requestOptions) {
      const response = await post(
        `${organizationPath(organizationId)}/files/${encodeURIComponent(fileId)}/text`,
        {},
        requestOptions,
      );

      const doing = `reading the text of file "${fileId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { pages } = await parsed<{ pages: { page: string; text: string }[] }>(response, doing);
      return pages;
    },

    async retireTasks({ organizationId, taskIds }, requestOptions) {
      const response = await post(
        `${organizationPath(organizationId)}/tasks/retire`,
        { taskIds },
        requestOptions,
      );

      if (response.status === 204) return;
      throw await unexpected(response, `retiring tasks in organization "${organizationId}"`);
    },

    async defineCourse(input, requestOptions) {
      const { organizationId, ...course } = input;
      const response = await post(
        `${organizationPath(organizationId)}/courses`,
        course,
        requestOptions,
      );

      const doing = `creating course "${input.title}" in organization "${organizationId}"`;
      if (response.status !== 201) throw await unexpected(response, doing);

      const { courseId } = await parsed<{ courseId: string }>(response, doing);
      return courseId;
    },

    async acceptDraft({ organizationId, sourceId, title, objectives }, requestOptions) {
      const objectiveIds = await client.defineObjectives(
        { organizationId, objectives: objectives.map(({ key, title }) => ({ key, title })) },
        requestOptions,
      );

      const citations = objectives.flatMap(({ citations }, index) =>
        citations.map((citation) => ({ objectiveId: objectiveIds[index]!, ...citation })),
      );
      if (citations.length > 0) {
        await client.citeSources({ organizationId, citations }, requestOptions);
      }

      const tasks = objectives.flatMap(({ tasks }, index) =>
        tasks.map((task) => ({ ...task, objectiveId: objectiveIds[index]! })),
      );
      if (tasks.length > 0) await client.defineTasks({ organizationId, tasks }, requestOptions);

      const key = `${sourceId}/course-${await digest([title, ...objectives.map(({ key }) => key)])}`;
      return client.defineCourse({ organizationId, title, objectiveIds, key }, requestOptions);
    },
  };
  return client;
}

/** The first 32 hex digits of a SHA-256 over the values as JSON, which no two lists share. */
async function digest(values: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** More than any explanation Braivo writes; a body past it is not one of Braivo's. */
const MAX_EXPLANATION_BYTES = 64 * 1024;

/**
 * Braivo's reason for refusing a request, and its `code` where it answers
 * one: the `error` of a JSON body on a status Braivo explains (400 a quote not in its source, 409 a key naming
 * something else, 403, 429, 501, 502 from the AI and file routes). Any other
 * body is cancelled unread: the status already says what failed, and waiting
 * on whatever else answered — a proxy's error page, a stream that never ends —
 * would only delay saying so. A JSON body is read no further than a real
 * explanation could run.
 */
async function explanation(response: Response): Promise<{ reason?: string; code?: string }> {
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
  const explained = [400, 403, 409, 429, 501, 502].includes(response.status);
  if (!explained || mediaType !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => {});
    return {};
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EXPLANATION_BYTES) {
        await reader.cancel();
        return {};
      }
      chunks.push(value);
    }
    const { error, code } = JSON.parse(new TextDecoder().decode(concatenate(chunks, size))) as {
      error?: unknown;
      code?: unknown;
    };
    return {
      reason: typeof error === "string" ? error : undefined,
      code: typeof code === "string" ? code : undefined,
    };
  } catch {
    // A dropped connection or a body that is not JSON: nothing Braivo explained.
    return {};
  }
}

function concatenate(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function organizationPath(organizationId: string): string {
  return `/api/organizations/${encodeURIComponent(organizationId)}`;
}
