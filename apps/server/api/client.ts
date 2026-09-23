// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  Activity,
  Course,
  Grade,
  GradedEvidence,
  KnowledgeReport,
  Objective,
  TaskResponse,
} from "./types.ts";

// The browser client for Braivo's HTTP API, which the learn and console apps
// import as `@braivo/server/client`. It is bundled into them, so it may import
// nothing from the server but types (`client.test.ts` checks).
//
// It covers what those apps call, not the whole API: the authoring routes in
// `api/index.ts` have no method here because no screen creates objectives or
// courses yet. Add one in the commit whose UI needs it.

export type {
  Activity,
  Course,
  Grade,
  GradedEvidence,
  KnowledgeReport,
  LearningDecision,
  Objective,
  ObjectiveStanding,
  TaskResponse,
} from "./types.ts";

/**
 * An answer the client could not use: a refusal, a status the method does not
 * expect from that endpoint, or a body that is not JSON. Not a request that got
 * no answer — a network failure or a cancellation rejects as `fetch` does.
 */
export class BraivoError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BraivoError";
    this.status = status;
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
   * What the signed-in learner should do next in a course — the decision and a
   * task to practise it — or `undefined` when there is nothing to practise now
   * (glossary: No activity), which is not necessarily caught up. A course that
   * does not exist and one this learner may not see are both a
   * {@link BraivoError} with status 404, deliberately indistinguishable.
   */
  nextActivity(courseId: string, options?: RequestOptions): Promise<Activity | undefined>;

  /**
   * Answers a task as the signed-in learner, and resolves to Braivo's grade.
   * `id` names the attempt and is the caller's to generate, once per attempt:
   * resending the same attempt after a lost answer records nothing twice and
   * resolves to the same grade, while reusing `id` for another answer is a
   * {@link BraivoError} with status 409. Other refusals, by status: 401 no
   * session; 404 course or task missing or not this learner's; 400 a response
   * that cannot answer the task; 403 possibly forged; 413 body over 1 MB.
   */
  submitAttempt(
    input: { courseId: string; id: string; taskId: string; response: TaskResponse },
    options?: RequestOptions,
  ): Promise<Grade>;

  /**
   * Where a learner stands on each objective in a course, for a content owner.
   * The session must hold `owner` or `admin` in the course's organization and
   * the learner must belong to it — so a learner cannot read their own, a
   * `member` not being an administrator.
   *
   * A missing course, a session that may not read it, and a learner outside the
   * organization are one {@link BraivoError} with status 404, which of the
   * three it was being exactly what Braivo declines to say.
   */
  learnerProgress(
    input: { courseId: string; learnerId: string },
    options?: RequestOptions,
  ): Promise<KnowledgeReport>;

  /**
   * The courses the signed-in learner may study, by title: every course of
   * every organization they belong to.
   */
  learnerCourses(options?: RequestOptions): Promise<Course[]>;

  /**
   * Every course an organization has, by title.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listCourses(organizationId: string, options?: RequestOptions): Promise<Course[]>;

  /**
   * Every objective an organization has registered, by title — a listing
   * order, not the order a course teaches them in.
   *
   * Whoever the session belongs to must hold `owner` or `admin` there, or this
   * throws a {@link BraivoError} with status 403.
   */
  listObjectives(organizationId: string, options?: RequestOptions): Promise<Objective[]>;

  /**
   * Records what a learner did, on behalf of an organization. The session must
   * hold `owner` or `admin` there: grading is a content owner's act, and a
   * learner able to grade themselves would be writing the history their own
   * estimates are rebuilt from.
   *
   * Redelivering a result is a no-op, so retrying after a timeout is safe. One
   * that disagrees with what its `id` already holds is a {@link BraivoError}
   * with status 409, and nothing in that batch is stored.
   */
  recordEvidence(
    input: {
      organizationId: string;
      learnerId: string;
      evidence: readonly GradedEvidence[];
    },
    options?: RequestOptions,
  ): Promise<void>;
};

/**
 * A client for the endpoints above. Paths are relative, so requests go to the
 * origin the app is served from — the only value a base URL could take, since
 * Braivo serves `/api` from every origin that serves an app (ADR 0004) and
 * sends no CORS headers to make any other one work.
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
  function unexpected(response: Response, doing: string): BraivoError {
    return new BraivoError(response.status, `Braivo answered ${response.status} ${doing}.`);
  }

  /**
   * A body as JSON, or a {@link BraivoError} when it is not — an empty 200, or
   * an HTML page something in between put there, which unconverted would reach
   * the caller as a `SyntaxError` carrying no status.
   *
   * Read to text first, then parsed, so that the only error caught here is one
   * this function raised: a dropped connection or the caller's cancellation
   * rejects out of `text()` untouched. `response.json()` raises both from one
   * call, and telling them apart took a reason-identity check and a cross-realm
   * name test that were still only inference.
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

  return {
    async nextActivity(courseId, requestOptions) {
      const response = await get(
        `/api/courses/${encodeURIComponent(courseId)}/activity`,
        requestOptions,
      );

      // Nothing to practise now. A missing course, or one not this learner's,
      // is a 404 and throws below.
      const doing = `asking what is next in course "${courseId}"`;
      if (response.status === 204) return undefined;
      if (response.status !== 200) throw unexpected(response, doing);

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
      if (response.status !== 200) throw unexpected(response, doing);

      return parsed<Grade>(response, doing);
    },

    async learnerProgress(input, requestOptions) {
      const response = await get(
        `/api/courses/${encodeURIComponent(input.courseId)}` +
          `/learners/${encodeURIComponent(input.learnerId)}/progress`,
        requestOptions,
      );

      const doing = `reading the progress of learner "${input.learnerId}" in course "${input.courseId}"`;
      if (response.status !== 200) throw unexpected(response, doing);

      return parsed<KnowledgeReport>(response, doing);
    },

    async learnerCourses(requestOptions) {
      const response = await get("/api/courses", requestOptions);

      const doing = "listing the learner's courses";
      if (response.status !== 200) throw unexpected(response, doing);

      const { courses } = await parsed<{ courses: Course[] }>(response, doing);
      return courses;
    },

    async listCourses(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/courses`,
        requestOptions,
      );

      const doing = `listing the courses of organization "${organizationId}"`;
      if (response.status !== 200) throw unexpected(response, doing);

      const { courses } = await parsed<{ courses: Course[] }>(response, doing);
      return courses;
    },

    async listObjectives(organizationId, requestOptions) {
      const response = await get(
        `/api/organizations/${encodeURIComponent(organizationId)}/objectives`,
        requestOptions,
      );

      const doing = `listing the objectives of organization "${organizationId}"`;
      if (response.status !== 200) throw unexpected(response, doing);

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
      throw unexpected(response, `recording evidence for learner "${input.learnerId}"`);
    },
  };
}
