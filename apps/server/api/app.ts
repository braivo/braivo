// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  addSource,
  chooseNextActivity,
  citeSources,
  chooseNextObjective,
  ConflictingEvidence,
  ConflictingKey,
  defineCourse,
  defineObjectives,
  defineTasks,
  type Ai,
  AiLimitReached,
  AiNotEntitled,
  AiUnavailable,
  draftFromSource,
  FilesUnavailable,
  getSource,
  InvalidCitation,
  InvalidAiRequest,
  InvalidEvidence,
  InvalidFile,
  InvalidKey,
  InvalidSource,
  InvalidTask,
  listCourses,
  listLearnerCourses,
  listManagedOrganizations,
  listMembers,
  listObjectiveCitations,
  listObjectives,
  listObjectiveTasks,
  listSources,
  ModelUnavailable,
  NotPermitted,
  openFile,
  readHostOrganization,
  readAuthoredCourse,
  readFileText,
  readLearnerProgress,
  recordGradedEvidence,
  type QuotedCitation,
  StaleCorrection,
  retireTasks,
  submitAttempt,
  type RequestHost,
  uploadFile,
} from "../application/index.ts";
import { type Auth, isOrganizationOrigin } from "../auth/index.ts";
import { isStorableText, MAX_TITLE } from "../content/index.ts";
import type { Evidence } from "../learning/index.ts";
import type { FileStore } from "../storage/index.ts";

/**
 * Reads evidence out of a request body, or nothing when the body is not
 * evidence. Hand-written because there is one shape and one endpoint, and every
 * field is checked: a malformed grading result must not become a row in the
 * table every estimate is rebuilt from.
 *
 * `at` must be exactly the form `Date#toISOString` produces. `new Date` is far
 * more forgiving than that, and forgiving is the wrong thing to be about a
 * timestamp the model orders replay by: it reads `"1"` as the year 2000, and
 * turns `2026-02-30` into March without complaint. Comparing the parsed date
 * back to the string it came from rejects both, and pins the value to UTC
 * rather than to whichever zone the server happens to sit in.
 */
function parseEvidence(body: unknown): Evidence[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const records = (body as { evidence?: unknown }).evidence;
  if (!Array.isArray(records)) return undefined;
  if (records.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const parsed: Evidence[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) return undefined;

    const { id, objectiveId, outcome, at } = record as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return undefined;
    if (typeof objectiveId !== "string" || objectiveId === "") return undefined;
    if (outcome !== "success" && outcome !== "failure") return undefined;
    if (typeof at !== "string") return undefined;

    const when = new Date(at);
    if (Number.isNaN(when.getTime()) || when.toISOString() !== at) return undefined;

    parsed.push({ id, objectiveId, outcome, at: when });
  }
  return parsed;
}

/**
 * Whether a state-changing request came from somewhere allowed to make it.
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-site POST from
 * carrying it but not a same-site one — and a sibling subdomain is same-site.
 * Two cheap checks close that gap. A browser cannot set `application/json`
 * cross-origin without a preflight this server never answers, and when it does
 * send an `Origin` it has to be ours. A server-to-server caller sends no
 * `Origin` at all and sets the content type, so neither check touches it.
 * Besides this installation's origin, an organization's domain serves the
 * learn app, and is registered only when the operator controls it (ADR 0004);
 * it writes only to itself.
 */
async function isTrustedWrite(
  context: Context,
  origin: string,
  database: Database,
  host: RequestHost,
): Promise<boolean> {
  // The media type alone, so that `application/json; charset=utf-8` is accepted
  // and `application/jsonp` is not — a prefix test would take both.
  const mediaType = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
  if (mediaType.trim().toLowerCase() !== "application/json") return false;

  // Each app calls its own origin's API, so a write comes from the host it is
  // sent to: a learn domain cannot write through the console's session.
  const requestOrigin = context.req.header("origin");
  if (requestOrigin === undefined) return true;
  if (host.installation) return requestOrigin === origin;
  return (
    URL.canParse(requestOrigin) &&
    new URL(requestOrigin).hostname === host.hostname &&
    isOrganizationOrigin(database, requestOrigin)
  );
}

/**
 * `isTrustedWrite` for a body that is a file rather than JSON. What a browser
 * sends cross-site without a preflight is a form's content type or none, so
 * an upload must name another; `text/plain` falls to that rule, which costs
 * nothing, since text is sent as a source rather than kept as a file.
 */
function isTrustedUpload(context: Context, origin: string): boolean {
  const mediaType = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
  const simple = ["", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];
  if (simple.includes(mediaType.trim().toLowerCase())) return false;

  const requestOrigin = context.req.header("origin");
  return requestOrigin === undefined || requestOrigin === origin;
}

export type ApiOptions = {
  auth: Auth;
  database: Database;
  /** The public origin this installation is served from, used to judge writes. */
  baseUrl: string;
  /** Where uploaded files are kept; without one, the file routes answer 501. */
  files?: FileStore;
  /** The installation's model, and who may use it; without one, AI routes answer 501. */
  ai?: Ai;
};

/**
 * Reads objectives out of a request body: each a title and, optionally, the
 * caller's key. Blank titles, and those past `MAX_TITLE`, are refused rather
 * than stored: an objective nobody can recognise is worse than none, and the
 * ID that names it is opaque by design. What a key may be is the use case's rule.
 */
function parseObjectives(body: unknown): { title: string; key?: string }[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const objectives = (body as { objectives?: unknown }).objectives;
  if (!Array.isArray(objectives)) return undefined;
  if (objectives.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const parsed: { title: string; key?: string }[] = [];
  for (const item of objectives) {
    if (typeof item !== "object" || item === null) return undefined;

    const { title, key } = item as Record<string, unknown>;
    if (typeof title !== "string") return undefined;
    if (key !== undefined && typeof key !== "string") return undefined;

    if (!isStorableText(title, MAX_TITLE)) return undefined;
    const trimmed = title.trim();

    parsed.push(key === undefined ? { title: trimmed } : { title: trimmed, key });
  }
  return parsed;
}

/**
 * The refusals of defining an objective or a course. A malformed or
 * conflicting key is explained, since the caller is often an agent that chose
 * it.
 */
function keyRefusal(context: Context, error: unknown): Response {
  if (error instanceof InvalidKey) return context.json({ error: error.message }, 400);
  if (error instanceof ConflictingKey) return context.json({ error: error.message }, 409);
  if (error instanceof NotPermitted) return context.body(null, 403);
  throw error;
}

/**
 * The statuses of a route that asks the installation's model: each refusal
 * explained, since the fix is someone's to make — the operator's for 501 and
 * 403, the caller's for 400, the calendar's for 429, nobody's but a retry's
 * for 502.
 */
function aiRefusal(context: Context, error: unknown): Response {
  if (error instanceof AiUnavailable || error instanceof FilesUnavailable) {
    return context.json({ error: error.message }, 501);
  }
  if (error instanceof InvalidAiRequest) return context.json({ error: error.message }, 400);
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
 * How many things one write may carry, whatever they are. One number until a
 * caller needs two — each turns into one row, and this is comfortably under
 * PostgreSQL's parameter ceiling for the widest of those inserts.
 */
const MAX_ITEMS_PER_REQUEST = 1000;

/**
 * How many quotes one write may ask Braivo to find, each a scan of a source of
 * up to `MAX_SOURCE_BYTES`. A unit's worth; more goes in several requests.
 */
const MAX_QUOTES_PER_REQUEST = 200;

/**
 * Reads a course out of a request body.
 *
 * Duplicate objectives are refused here rather than left to the database, which
 * would reject the second membership row as a constraint violation — a 500 for
 * what is plainly a malformed request. An objective belongs to a course at most
 * once, because position is what orders it and two positions would contradict.
 */
function parseCourse(
  body: unknown,
): { title: string; objectiveIds: string[]; key?: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { title, objectiveIds, key } = body as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  if (key !== undefined && typeof key !== "string") return undefined;

  if (!isStorableText(title, MAX_TITLE)) return undefined;
  const trimmed = title.trim();

  if (!Array.isArray(objectiveIds)) return undefined;
  if (objectiveIds.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const ids: string[] = [];
  for (const id of objectiveIds) {
    if (typeof id !== "string" || id === "") return undefined;
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return undefined;

  return key === undefined
    ? { title: trimmed, objectiveIds: ids }
    : { title: trimmed, objectiveIds: ids, key };
}

/**
 * Reads an attempt's envelope out of a request body. The response inside it is
 * the task's to judge, so it passes through unread: only the use case knows
 * which task it answers.
 */
function parseAttempt(
  body: unknown,
): { id: string; taskId: string; response: unknown } | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { id, taskId, response } = body as Record<string, unknown>;
  if (typeof id !== "string") return undefined;
  if (typeof taskId !== "string" || taskId === "") return undefined;

  return { id, taskId, response };
}

/**
 * Reads tasks out of a request body: each an `objectiveId`, optional
 * `citations`, and an optional task it `replaces`, beside the fields of its
 * kind. Only the envelope is read here;
 * the body is `content`'s to judge, and the quotes are located by the use case.
 */
function parseTasks(body: unknown): ParsedTask[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const tasks = (body as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return undefined;
  if (tasks.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const parsed: ParsedTask[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) return undefined;

    const { objectiveId, citations, replaces, ...rest } = task as Record<string, unknown>;
    if (typeof objectiveId !== "string" || objectiveId === "") return undefined;
    if (replaces !== undefined && (typeof replaces !== "string" || replaces === "")) {
      return undefined;
    }
    const envelope = { objectiveId, body: rest, ...(replaces !== undefined && { replaces }) };

    if (citations === undefined) {
      parsed.push(envelope);
      continue;
    }
    if (!Array.isArray(citations) || citations.length > MAX_CITATIONS_PER_TASK) return undefined;

    const quoted: { sourceId: string; quote: string }[] = [];
    for (const citation of citations) {
      if (typeof citation !== "object" || citation === null) return undefined;

      const { sourceId, quote } = citation as Record<string, unknown>;
      if (typeof sourceId !== "string" || sourceId === "") return undefined;
      if (typeof quote !== "string") return undefined;

      quoted.push({ sourceId, quote });
    }
    parsed.push({ ...envelope, citations: quoted });
  }
  const quotes = parsed.reduce((sum, task) => sum + (task.citations?.length ?? 0), 0);
  return quotes > MAX_QUOTES_PER_REQUEST ? undefined : parsed;
}

/** Reads `taskIds`, each non-empty, out of a request body. */
function parseTaskIds(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const ids = (body as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(ids) || ids.length > MAX_ITEMS_PER_REQUEST) return undefined;
  if (!ids.every((id) => typeof id === "string" && id !== "")) return undefined;
  return ids as string[];
}

type ParsedTask = {
  objectiveId: string;
  body: unknown;
  citations?: { sourceId: string; quote: string }[];
  replaces?: string;
};

/**
 * A question is written from a passage or two, not a chapter's worth.
 */
const MAX_CITATIONS_PER_TASK = 10;

/**
 * Whole seconds until `when`, rounded up so a client waiting that long is never
 * early. A duration, not a date: the client's clock may disagree with this one.
 */
function secondsUntil(when: Date, now: Date): number {
  return Math.ceil((when.getTime() - now.getTime()) / 1000);
}

/**
 * Reads a source out of a request body: a title, and exactly one of `text`, a
 * recording's `cues`, or a document's `pages`. Only the types: what makes each
 * value valid is `content`'s rule, applied by the use case. `url`, `language`,
 * and `original` are optional, and absent is the only way to leave one out.
 */
function parseSource(
  body: unknown,
):
  | ({ title: string; url?: string; language?: string; original?: string } & (
      | { text: string }
      | { cues: { at: number; text: string }[] }
      | { pages: { page: string; text: string }[] }
    ))
  | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { title, text, cues, pages, url, language, original } = body as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  if (url !== undefined && typeof url !== "string") return undefined;
  if (language !== undefined && typeof language !== "string") return undefined;
  if (original !== undefined && typeof original !== "string") return undefined;
  const common = { title, url, language, original };

  const sent = [text, cues, pages].filter((value) => value !== undefined);
  if (sent.length !== 1) return undefined;
  if (typeof text === "string") return { ...common, text };

  if (Array.isArray(cues)) {
    const parsed: { at: number; text: string }[] = [];
    for (const cue of cues) {
      if (typeof cue !== "object" || cue === null) return undefined;
      const { at, text: said } = cue as Record<string, unknown>;
      if (typeof at !== "number" || typeof said !== "string") return undefined;
      parsed.push({ at, text: said });
    }
    return { ...common, cues: parsed };
  }

  if (Array.isArray(pages)) {
    const parsed: { page: string; text: string }[] = [];
    for (const each of pages) {
      if (typeof each !== "object" || each === null) return undefined;
      const { page, text: written } = each as Record<string, unknown>;
      if (typeof page !== "string" || typeof written !== "string") return undefined;
      parsed.push({ page, text: written });
    }
    return { ...common, pages: parsed };
  }

  return undefined;
}

/** Reads citations out of a request body: only their types, as for a source. */
function parseCitations(body: unknown): QuotedCitation[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const citations = (body as { citations?: unknown }).citations;
  if (!Array.isArray(citations)) return undefined;
  if (citations.length > MAX_QUOTES_PER_REQUEST) return undefined;

  const parsed: QuotedCitation[] = [];
  for (const citation of citations) {
    if (typeof citation !== "object" || citation === null) return undefined;

    const { objectiveId, sourceId, quote } = citation as Record<string, unknown>;
    if (typeof objectiveId !== "string" || objectiveId === "") return undefined;
    if (typeof sourceId !== "string" || sourceId === "") return undefined;
    if (typeof quote !== "string") return undefined;

    parsed.push({ objectiveId, sourceId, quote });
  }
  return parsed;
}

/** Enough for that many records, and far less than a body worth buffering. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * A file is buffered whole, to be hashed before it is stored: a textbook's
 * PDF, a worksheet's scan, a slide deck. Video, larger, needs a direct
 * upload to the store instead (ADR 0028).
 */
const MAX_FILE_BYTES = 50_000_000;

/**
 * A source is one document's text, and a textbook's runs to a few megabytes.
 * Larger material is split into several sources, which is also the grain a
 * citation is easiest to review at.
 */
const MAX_SOURCE_BYTES = 10_000_000;

/** What Better Auth answers a bearer token: who it is, and their organizations. */
const BEARER_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/organization/list",
]);

/**
 * The HTTP entry point to `application`. A route resolves who is asking, calls
 * one use case, and turns its result into a status; anything it had to look up
 * for itself would be a workflow, and workflows belong to `application`.
 *
 * A factory rather than a module-level app, so nothing reads the environment at
 * import time and a test can serve its own database.
 *
 * Endpoints and statuses: `index.ts`. Why any of it: ADR 0010.
 */
export function createApi(options: ApiOptions) {
  const { auth, database, files, ai } = options;
  const origin = new URL(options.baseUrl).origin;
  const installationHostname = new URL(options.baseUrl).hostname;
  const api = new Hono();

  /** The host a request was sent to, which `hostAdmits` limits routes by. */
  const requestHost = (context: Context): RequestHost => {
    const { hostname } = new URL(context.req.url);
    return { hostname, installation: hostname === installationHostname };
  };

  // The installation's origin is the console's and its tools': the account's
  // own credentials — sign-up, the device flow, a bearer token — and the
  // console's API reach nothing on any other host, which serves one
  // organization's learn app (ADR 0004, ADR 0022). Before authentication, so
  // a credential presented elsewhere is refused whatever it could do.
  api.use("/api/*", async (context, next) => {
    if (requestHost(context).installation) return next();
    // A refusal here depends on the host, so no shared cache may keep one.
    context.header("cache-control", "private, no-store");
    if (context.req.header("authorization") !== undefined) return context.body(null, 401);
    const { path } = context.req;
    const installationOnly = ["/api/organizations", "/api/auth/sign-up/", "/api/auth/device"];
    if (installationOnly.some((prefix) => path.startsWith(prefix))) {
      return context.body(null, 404);
    }
    return next();
  });

  // Better Auth owns the routing below this path (ADR 0006); Braivo still owes
  // it the protections. Unguarded, `sign-up/email` accepts a megabytes-long
  // name unauthenticated, and `organization/list` answers with one caller's
  // organizations under no cache header at all.
  api.on(
    ["GET", "POST"],
    "/api/auth/*",
    // Set on every answer, Braivo's own refusals below included, not only the
    // ones Better Auth leaves bare: nothing under this mount is public with the
    // plugins in use, and exempting a header that already said `no-store` only
    // ever skipped this same value.
    async (context, next) => {
      await next();
      context.res.headers.set("cache-control", "private, no-store");
    },
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      // A tool's token is for Braivo's API and for finding its way there, not
      // for managing the account — approving another device, changing an
      // email — which takes the person in their browser.
      const bearer = context.req.header("authorization") !== undefined;
      if (bearer && !BEARER_AUTH_PATHS.has(context.req.path)) return context.body(null, 403);

      // Copied, since a library's response may carry immutable headers.
      const answered = await auth.handler(context.req.raw);
      const response = new Response(answered.body, answered);
      // A renewed session comes back as a signed cookie, which the bearer
      // plugin also copies into `set-auth-token`: either would carry a token's
      // session past every limit set on bearers here.
      if (bearer) {
        response.headers.delete("set-cookie");
        response.headers.delete("set-auth-token");
      }
      return response;
    },
  );

  /**
   * The session behind a request, with Better Auth's renewal cookies forwarded.
   * It renews past the update interval and answers with a replacement cookie;
   * calling its API directly means that header arrives here, and dropping it
   * would sign out a client that only ever calls these routes, however active.
   */
  async function sessionFor(context: Context) {
    const { headers, response } = await auth.api.getSession({
      headers: context.req.raw.headers,
      returnHeaders: true,
    });

    // Not to a bearer, which renews by being used, and must not be handed a
    // cookie it could carry where tokens are refused.
    if (context.req.header("authorization") !== undefined) return response;
    for (const cookie of headers.getSetCookie()) {
      context.header("set-cookie", cookie, { append: true });
    }
    return response;
  }

  /**
   * The organization this request's host serves, which a learn app on that
   * domain is branded as. No session: the domain is public and so is its name.
   * The host is the request URL's, so a router in front must forward `Host`.
   */
  api.get("/api/organization", async (context) => {
    // The same URL names a different organization on every domain, and a
    // rename should show on the next load.
    context.header("cache-control", "private, no-store");

    const found = await readHostOrganization({
      database,
      hostname: new URL(context.req.url).hostname,
    });

    return found ? context.json(found) : context.body(null, 404);
  });

  /**
   * What the signed-in learner should do next in a course. The learner is the
   * session's user and never a value from the request: unlike the routes below,
   * this one has no reason to name somebody else, so there is nothing to
   * authorize and nothing to get wrong.
   */
  api.get("/api/courses/:courseId/next", async (context) => {
    // Set before anything can fail, so every answer this route gives carries it,
    // a 500 out of the session lookup included. One URL, a different answer per
    // cookie — and a `Cookie` request header does not by itself stop a shared
    // cache handing one learner another's.
    context.header("cache-control", "private, no-store");

    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const next = await chooseNextObjective({
      database,
      learnerId: session.user.id,
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now: new Date(),
    });

    switch (next.kind) {
      // One status for two cases, the course not existing and the course not
      // being this learner's. A 404 that appeared only for courses belonging to
      // somebody else would enumerate them one guess at a time.
      case "unavailable":
        return context.body(null, 404);
      // Distinct from the above, and safe to be: it is only reachable by a
      // learner already entitled to the course.
      case "caught-up":
        return context.body(null, 204);
      case "decided":
        return context.json(next.decision);
      // A new answer added to `NextObjective` fails to compile here instead of
      // falling out of the switch as a response nobody chose.
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(next satisfies never)}`);
    }
  });

  /** The courses the signed-in learner may study, from the session alone. */
  api.get("/api/courses", async (context) => {
    context.header("cache-control", "private, no-store");

    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const courses = await listLearnerCourses({
      database,
      learnerId: session.user.id,
      host: requestHost(context),
    });
    return context.json({ courses });
  });

  /**
   * The signed-in learner's next objective, with a task to practise it or, while
   * its tasks rest, when to ask again. Statuses as for the decision route.
   */
  api.get("/api/courses/:courseId/activity", async (context) => {
    context.header("cache-control", "private, no-store");

    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const now = new Date();
    const next = await chooseNextActivity({
      database,
      learnerId: session.user.id,
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now,
    });

    switch (next.kind) {
      case "unavailable":
        return context.body(null, 404);
      case "caught-up":
        return context.body(null, 204);
      case "no-activity":
        return context.json({ decision: next.decision, objective: next.objective });
      case "resting":
        return context.json({
          objective: next.objective,
          retryAfter: secondsUntil(next.retryAt, now),
        });
      case "decided":
        return context.json({
          decision: next.decision,
          objective: next.objective,
          task: next.task,
        });
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(next satisfies never)}`);
    }
  });

  /**
   * The signed-in learner answers a task; Braivo grades it and records the
   * evidence. The learner is the session's user, as on the activity route.
   */
  api.post(
    "/api/courses/:courseId/attempts",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const attempt = parseAttempt(await context.req.json().catch(() => undefined));
      if (attempt === undefined) return context.body(null, 400);

      const submitted = await submitAttempt({
        database,
        learnerId: session.user.id,
        courseId: context.req.param("courseId"),
        host: requestHost(context),
        attemptId: attempt.id,
        taskId: attempt.taskId,
        response: attempt.response,
        now: new Date(),
      });

      switch (submitted.kind) {
        case "unavailable":
          return context.body(null, 404);
        case "invalid":
          return context.body(null, 400);
        // Both mean "reload the activity". A 429 would invite resending the
        // refused answer after the rest, though it was chosen with the feedback on screen.
        case "conflict":
        case "resting":
          return context.body(null, 409);
        case "graded":
          // `passages` only when there are some, as `explanation` only when
          // the task has one: a hand-written task cites nothing.
          return context.json(
            submitted.passages.length > 0
              ? { ...submitted.grade, passages: submitted.passages }
              : submitted.grade,
          );
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(submitted satisfies never)}`);
      }
    },
  );

  /**
   * Where a learner stands on each objective in a course, for a content owner
   * or the learner themselves.
   *
   * The learner is named in the path, as the evidence route names one, because
   * the reader may be someone else. Who that reader is comes from the session
   * and is never named; whether they may read it is decided by the use case.
   */
  api.get("/api/courses/:courseId/learners/:learnerId/progress", async (context) => {
    // First, as on the decision route: the same URL answers differently
    // depending on who is allowed to read it.
    context.header("cache-control", "private, no-store");

    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const progress = await readLearnerProgress({
      database,
      viewedBy: session.user.id,
      learnerId: context.req.param("learnerId"),
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now: new Date(),
    });

    switch (progress.kind) {
      // Every refusal, and a course that is not there, answer alike; see
      // `LearnerProgress` for what that keeps from the reader.
      case "unavailable":
        return context.body(null, 404);
      case "assessed":
        return context.json(progress.report);
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(progress satisfies never)}`);
    }
  });

  /**
   * Records what a learner did, on behalf of an organization. The organization
   * and the learner are named in the path because they are what is written to;
   * the grader is the session's user, never named, and whether they may grade
   * here is the use case's decision, not this route's.
   */
  api.post(
    "/api/organizations/:organizationId/learners/:learnerId/evidence",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      // Before the session is even resolved: a forged request should cost this
      // server nothing, and the answer does not depend on who it claims to be.
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const evidence = parseEvidence(await context.req.json().catch(() => undefined));
      if (evidence === undefined) return context.body(null, 400);

      try {
        await recordGradedEvidence({
          database,
          organizationId: context.req.param("organizationId"),
          gradedBy: session.user.id,
          learnerId: context.req.param("learnerId"),
          evidence,
          now: new Date(),
        });
      } catch (error) {
        // The same status as a malformed body: either way the caller has to fix
        // what they sent, and nothing was recorded.
        if (error instanceof InvalidEvidence) return context.body(null, 400);
        // Not 400: the body is fine on its own and only disagrees with what is
        // already stored, and a grader chasing a 400 would look at its format
        // rather than at how it builds evidence IDs.
        if (error instanceof ConflictingEvidence) return context.body(null, 409);
        // 403 rather than 404: the caller named the organization themselves, and
        // learning that they may not grade for it tells them nothing they did
        // not already assert. Nothing past the grader check runs until it
        // passes, so this cannot be used to probe for learners or objectives.
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }

      return context.body(null, 204);
    },
  );

  /**
   * Registers learning targets for an organization: the vocabulary evidence and
   * courses are written against.
   */
  api.post(
    "/api/organizations/:organizationId/objectives",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const objectives = parseObjectives(await context.req.json().catch(() => undefined));
      if (objectives === undefined) return context.body(null, 400);

      try {
        const objectiveIds = await defineObjectives({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          objectives,
        });

        return context.json({ objectiveIds }, 201);
      } catch (error) {
        return keyRefusal(context, error);
      }
    },
  );

  /**
   * Adds tasks to the organization's objectives: what a learner answers, and
   * what the activity route offers them.
   */
  api.post(
    "/api/organizations/:organizationId/tasks",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const tasks = parseTasks(await context.req.json().catch(() => undefined));
      if (tasks === undefined) return context.body(null, 400);

      try {
        const taskIds = await defineTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          tasks,
          now: new Date(),
        });

        return context.json({ taskIds }, 201);
      } catch (error) {
        // Explained, as on the citations route, so a drafting model can fix it.
        if (error instanceof InvalidTask || error instanceof InvalidCitation) {
          return context.json({ error: error.message }, 400);
        }
        if (error instanceof StaleCorrection) {
          return context.json({ error: error.message }, 409);
        }
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /**
   * Withdraws tasks from practice. A POST rather than a DELETE, because nothing
   * is deleted: the tasks stay, for the attempts that point at them.
   */
  api.post(
    "/api/organizations/:organizationId/tasks/retire",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const taskIds = parseTaskIds(await context.req.json().catch(() => undefined));
      if (taskIds === undefined) return context.body(null, 400);

      try {
        await retireTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          taskIds,
          now: new Date(),
        });
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /**
   * Creates a course: an ordered set of the organization's own objectives.
   *
   * Position in `objectiveIds` is content order, and that list is what selection
   * chooses from — so this is the route that turns a set of learning targets
   * into something a learner can actually be led through.
   */
  api.post(
    "/api/organizations/:organizationId/courses",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const course = parseCourse(await context.req.json().catch(() => undefined));
      if (course === undefined) return context.body(null, 400);

      try {
        const courseId = await defineCourse({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          ...course,
        });

        return context.json({ courseId }, 201);
      } catch (error) {
        return keyRefusal(context, error);
      }
    },
  );

  /** The organizations the session's user manages. */
  api.get("/api/organizations", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const organizations = await listManagedOrganizations({ database, actingAs: session.user.id });
    return context.json({ organizations });
  });

  /** Every member of an organization, for whoever administers it. */
  api.get("/api/organizations/:organizationId/members", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const members = await listMembers({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
      });

      return context.json({ members });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /**
   * One course as authored — objectives in order, each with its passages and
   * tasks, answers included — for whoever administers its organization.
   */
  api.get("/api/organizations/:organizationId/courses/:courseId", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const course = await readAuthoredCourse({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
        courseId: context.req.param("courseId"),
      });
      if (!course) return context.body(null, 404);

      return context.json({
        ...course,
        objectives: course.objectives.map(({ tasks, ...objective }) => ({
          ...objective,
          // As `GET …/objectives/:objectiveId/tasks` answers them.
          tasks: tasks.map(({ id, body, citations }) => ({ id, ...body, citations })),
        })),
      });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /** Every course an organization has, for whoever administers it. */
  api.get("/api/organizations/:organizationId/courses", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const courses = await listCourses({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
      });

      return context.json({ courses });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /** Every objective an organization has defined, for whoever administers it. */
  api.get("/api/organizations/:organizationId/objectives", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const objectives = await listObjectives({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
      });

      return context.json({ objectives });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /**
   * Adds material a content owner provides, as text. Extracting that text from
   * a file is the caller's business, which is what lets a content owner's own
   * tools do it (ADR 0020).
   */
  api.post(
    "/api/organizations/:organizationId/sources",
    bodyLimit({ maxSize: MAX_SOURCE_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const source = parseSource(await context.req.json().catch(() => undefined));
      if (source === undefined) return context.body(null, 400);

      try {
        const sourceId = await addSource({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          ...source,
          now: new Date(),
        });

        return context.json({ sourceId }, 201);
      } catch (error) {
        if (error instanceof InvalidSource) return context.json({ error: error.message }, 400);
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /** Every source an organization has, without their text, for whoever administers it. */
  api.get("/api/organizations/:organizationId/sources", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const sources = await listSources({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
      });

      return context.json({ sources });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /**
   * Links objectives to the passages of sources that teach them. Braivo, not
   * the caller, decides where a quote is: that check is what makes derived
   * content grounded rather than merely attributed (ADR 0021).
   */
  api.post(
    "/api/organizations/:organizationId/citations",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const citations = parseCitations(await context.req.json().catch(() => undefined));
      if (citations === undefined) return context.body(null, 400);

      try {
        const located = await citeSources({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          citations,
        });

        return context.json({ citations: located });
      } catch (error) {
        // Explained: the caller is often a model drafting from a source, and
        // "quote more of it" is something it can act on where a bare status is
        // not.
        if (error instanceof InvalidCitation) return context.json({ error: error.message }, 400);
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /** The passages an objective cites, for whoever administers its organization. */
  api.get(
    "/api/organizations/:organizationId/objectives/:objectiveId/citations",
    async (context) => {
      context.header("cache-control", "private, no-store");
      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      try {
        const citations = await listObjectiveCitations({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          objectiveId: context.req.param("objectiveId"),
        });

        return citations ? context.json({ citations }) : context.body(null, 404);
      } catch (error) {
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /**
   * An objective's tasks still offered, as authored and with the passages they
   * cite, for whoever administers its organization: answers included, so
   * never a learner's.
   */
  api.get("/api/organizations/:organizationId/objectives/:objectiveId/tasks", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const tasks = await listObjectiveTasks({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
        objectiveId: context.req.param("objectiveId"),
      });
      if (!tasks) return context.body(null, 404);

      // The shape a task is authored in, so one read back can be sent again.
      return context.json({
        tasks: tasks.map(({ id, body, citations }) => ({ id, ...body, citations })),
      });
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /**
   * A course drafted from a source by the installation's own model, checked
   * against the source and returned for review — never stored (ADR 0029).
   * Slow: the model reads the whole source.
   */
  api.post(
    "/api/organizations/:organizationId/sources/:sourceId/draft",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const body = (await context.req.json().catch(() => undefined)) as unknown;
      if (typeof body !== "object" || body === null) return context.body(null, 400);
      const { audience } = body as Record<string, unknown>;

      // Bun, Hono's `env` here, closes a connection idle for ten seconds, and a
      // model reading a chapter takes longer: this request waits instead for as
      // long as the model may take (`ai`'s own timeout).
      const server = context.env as
        | { timeout?: (request: Request, seconds: number) => void }
        | undefined;
      server?.timeout?.(context.req.raw, 0);
      if (audience !== undefined && typeof audience !== "string") return context.body(null, 400);

      try {
        const draft = await draftFromSource({
          database,
          ai,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          sourceId: context.req.param("sourceId"),
          audience,
          now: new Date(),
          signal: context.req.raw.signal,
        });
        return draft ? context.json(draft) : context.body(null, 404);
      } catch (error) {
        return aiRefusal(context, error);
      }
    },
  );

  /** One source, text included, for whoever administers its organization. */
  api.get("/api/organizations/:organizationId/sources/:sourceId", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const source = await getSource({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
        sourceId: context.req.param("sourceId"),
      });

      // Reached only by an administrator, so a 404 confirms nothing they could
      // not already list.
      return source ? context.json(source) : context.body(null, 404);
    } catch (error) {
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  /**
   * Keeps a file a content owner uploads — the original a source's text was
   * extracted from — as the request's body, typed by its `Content-Type`.
   */
  api.post(
    "/api/organizations/:organizationId/files",
    bodyLimit({ maxSize: MAX_FILE_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!isTrustedUpload(context, origin)) return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      try {
        const file = await uploadFile({
          database,
          files,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          bytes: new Uint8Array(await context.req.arrayBuffer()),
          contentType: context.req.header("content-type") ?? "",
          now: new Date(),
        });

        const { sha256, contentType, size } = file;
        return context.json({ fileId: sha256, contentType, size }, 201);
      } catch (error) {
        if (error instanceof FilesUnavailable) return context.json({ error: error.message }, 501);
        if (error instanceof InvalidFile) return context.json({ error: error.message }, 400);
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

  /**
   * A file's text, page by page, read by the installation's model and returned
   * for the caller to add as a source (ADR 0030). Slow, as drafting is.
   */
  api.post(
    "/api/organizations/:organizationId/files/:fileId/text",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!(await isTrustedWrite(context, origin, database, requestHost(context))))
        return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      // As for drafting: past Bun's ten-second idle timeout, bounded by the model's.
      const server = context.env as
        | { timeout?: (request: Request, seconds: number) => void }
        | undefined;
      server?.timeout?.(context.req.raw, 0);

      try {
        const pages = await readFileText({
          database,
          ai,
          files,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          fileId: context.req.param("fileId"),
          now: new Date(),
          signal: context.req.raw.signal,
        });
        return pages ? context.json({ pages }) : context.body(null, 404);
      } catch (error) {
        return aiRefusal(context, error);
      }
    },
  );

  /**
   * A file's bytes, for whoever administers its organization. Always a
   * download, never rendered: an uploaded HTML file served inline from this
   * origin would run as Braivo.
   */
  api.get("/api/organizations/:organizationId/files/:fileId", async (context) => {
    context.header("cache-control", "private, no-store");
    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    try {
      const opened = await openFile({
        database,
        files,
        organizationId: context.req.param("organizationId"),
        actingAs: session.user.id,
        fileId: context.req.param("fileId"),
      });
      if (!opened) return context.body(null, 404);

      // A stream, not the blob: Bun refuses a bucket's file with response options.
      return new Response(opened.bytes.stream(), {
        headers: {
          "cache-control": "private, no-store",
          "content-type": opened.file.contentType,
          "content-length": String(opened.file.size),
          "content-disposition": "attachment",
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof FilesUnavailable) return context.json({ error: error.message }, 501);
      if (error instanceof NotPermitted) return context.body(null, 403);
      throw error;
    }
  });

  return api;
}

export type Api = ReturnType<typeof createApi>;
