// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  Activity,
  AuthoredCourse,
  AuthoredTask,
  Course,
  CourseProgressOverview,
  Draft,
  Grade,
  GradedEvidence,
  Handoff,
  HostOrganization,
  LearnerProgressReport,
  LocatedCitation,
  Member,
  Objective,
  Organization,
  QuotedCitation,
  SessionUser,
  SignInMethods,
  Source,
  SourceSummary,
  TaskDraft,
  TaskResponse,
} from "./types.ts";

// The client for Braivo's HTTP API, which the learn and console apps import as
// `@braivo/server/client` and the `braivo` CLI uses to reach a remote
// installation. It is bundled into the apps, so it may import nothing from the
// server but types (`client.test.ts` checks).
//
// It covers what its callers call, not the whole API: an authoring route with
// no method here is one no screen or command uses. Add one in the commit whose
// caller needs it.

export type {
  Activity,
  AuthoredCourse,
  AuthoredTask,
  Course,
  CourseProgressOverview,
  Draft,
  Grade,
  GradedEvidence,
  Handoff,
  HostOrganization,
  LearnerProgressReport,
  LearningDecision,
  LocatedCitation,
  Member,
  Objective,
  LearnerProgressStanding,
  Organization,
  Passage,
  QuotedCitation,
  SessionUser,
  SignInMethods,
  Source,
  SourceSummary,
  TaskDraft,
  TaskResponse,
} from "./types.ts";

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

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "BraivoError";
    this.status = status;
    this.reason = reason;
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

  /** How the installation's `/login` may sign people in besides an emailed code. */
  signInMethods(options?: RequestOptions): Promise<SignInMethods>;

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
   * objective, and a task to practise it unless the objective has none; or the
   * objective while its tasks rest — or `undefined` when they are caught up. A
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
   * Where a learner stands on each objective in a course, for a content owner
   * or the learner. The session must be the learner's, or hold `owner` or
   * `admin` in the course's organization, and the learner must belong to it.
   *
   * A missing course, a session that may not read it, and a learner outside the
   * organization are one {@link BraivoError} with status 404, which of the
   * three it was being exactly what Braivo declines to say.
   */
  learnerProgress(
    input: { courseId: string; learnerId: string },
    options?: RequestOptions,
  ): Promise<LearnerProgressReport>;

  /**
   * Where each learner in a course stands, counted: every member of its
   * organization, by name. The session must hold `owner` or `admin` there.
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
   * The organizations the session's user manages, holding `owner` or `admin`,
   * by name — not every one they are in, since a learner is a member too.
   */
  listOrganizations(options?: RequestOptions): Promise<Organization[]>;

  /**
   * Every member of an organization, by name, without their emails.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listMembers(organizationId: string, options?: RequestOptions): Promise<Member[]>;

  /**
   * Every course an organization has, by title.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listCourses(organizationId: string, options?: RequestOptions): Promise<Course[]>;

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
   * means someone changed the task first.
   */
  defineTasks(
    input: { organizationId: string; tasks: readonly TaskDraft[] },
    options?: RequestOptions,
  ): Promise<string[]>;

  /**
   * An objective's tasks still offered, oldest first, as authored — answers
   * included — with the passages each cites. An objective the organization
   * does not have is a {@link BraivoError} with status 404; one the session
   * may not administer, 403.
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
   * with status 403.
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
    const reason = await explanation(response);
    return new BraivoError(
      response.status,
      `Braivo answered ${response.status} ${doing}${reason ? `: ${reason}` : "."}`,
      reason,
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

    async signInMethods(requestOptions) {
      const response = await get("/api/sign-in-methods", requestOptions);

      const doing = "asking how to sign in";
      if (response.status !== 200) throw await unexpected(response, doing);

      return parsed<SignInMethods>(response, doing);
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
      const response = await get(
        `/api/courses/${encodeURIComponent(courseId)}/activity`,
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

    async learnerProgress(input, requestOptions) {
      const response = await get(
        `/api/courses/${encodeURIComponent(input.courseId)}` +
          `/learners/${encodeURIComponent(input.learnerId)}/progress`,
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

    async listOrganizations(requestOptions) {
      const response = await get("/api/organizations", requestOptions);

      const doing = "listing the organizations you manage";
      if (response.status !== 200) throw await unexpected(response, doing);

      const { organizations } = await parsed<{ organizations: Organization[] }>(response, doing);
      return organizations;
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

    async listCourses(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/courses`,
        requestOptions,
      );

      const doing = `listing the courses of organization "${organizationId}"`;
      if (response.status !== 200) throw await unexpected(response, doing);

      const { courses } = await parsed<{ courses: Course[] }>(response, doing);
      return courses;
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
 * Braivo's reason for refusing a request: the `error` of a JSON body on a
 * status Braivo explains (400 a quote not in its source, 409 a key naming
 * something else, 403, 429, 501, 502 from the AI and file routes). Any other
 * body is cancelled unread: the status already says what failed, and waiting
 * on whatever else answered — a proxy's error page, a stream that never ends —
 * would only delay saying so. A JSON body is read no further than a real
 * explanation could run.
 */
async function explanation(response: Response): Promise<string | undefined> {
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
  const explained = [400, 403, 409, 429, 501, 502].includes(response.status);
  if (!explained || mediaType !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => {});
    return undefined;
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
        return undefined;
      }
      chunks.push(value);
    }
    const { error } = JSON.parse(new TextDecoder().decode(concatenate(chunks, size))) as {
      error?: unknown;
    };
    return typeof error === "string" ? error : undefined;
  } catch {
    // A dropped connection or a body that is not JSON: nothing Braivo explained.
    return undefined;
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
