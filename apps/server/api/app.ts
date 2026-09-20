// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  chooseNextObjective,
  ConflictingEvidence,
  defineCourse,
  defineObjectives,
  InvalidEvidence,
  listCourses,
  listObjectives,
  NotPermitted,
  readLearnerProgress,
  recordGradedEvidence,
} from "../application/index.ts";
import type { Auth } from "../auth/index.ts";
import type { Evidence } from "../learning/index.ts";

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
 */
function isTrustedWrite(context: Context, origin: string): boolean {
  // The media type alone, so that `application/json; charset=utf-8` is accepted
  // and `application/jsonp` is not — a prefix test would take both.
  const mediaType = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
  if (mediaType.trim().toLowerCase() !== "application/json") return false;

  const requestOrigin = context.req.header("origin");
  return requestOrigin === undefined || requestOrigin === origin;
}

export type ApiOptions = {
  auth: Auth;
  database: Database;
  /** The public origin this installation is served from, used to judge writes. */
  baseUrl: string;
};

/**
 * Reads objective titles out of a request body. Blank titles are refused rather
 * than stored: an objective nobody can recognise is worse than none, and the ID
 * that names it is opaque by design.
 */
function parseTitles(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const titles = (body as { titles?: unknown }).titles;
  if (!Array.isArray(titles)) return undefined;
  if (titles.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const parsed: string[] = [];
  for (const title of titles) {
    if (typeof title !== "string") return undefined;

    const trimmed = title.trim();
    if (trimmed === "") return undefined;

    parsed.push(trimmed);
  }
  return parsed;
}

/**
 * How many things one write may carry, whatever they are: evidence records,
 * objective titles, a course's objectives. One number until a caller needs two —
 * each turns into one row, and this is comfortably under PostgreSQL's parameter
 * ceiling for the widest of those inserts.
 */
const MAX_ITEMS_PER_REQUEST = 1000;

/**
 * Reads a course out of a request body.
 *
 * Duplicate objectives are refused here rather than left to the database, which
 * would reject the second membership row as a constraint violation — a 500 for
 * what is plainly a malformed request. An objective belongs to a course at most
 * once, because position is what orders it and two positions would contradict.
 */
function parseCourse(body: unknown): { title: string; objectiveIds: string[] } | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { title, objectiveIds } = body as { title?: unknown; objectiveIds?: unknown };
  if (typeof title !== "string") return undefined;

  const trimmed = title.trim();
  if (trimmed === "") return undefined;

  if (!Array.isArray(objectiveIds)) return undefined;
  if (objectiveIds.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const ids: string[] = [];
  for (const id of objectiveIds) {
    if (typeof id !== "string" || id === "") return undefined;
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return undefined;

  return { title: trimmed, objectiveIds: ids };
}

/** Enough for that many records, and far less than a body worth buffering. */
const MAX_BODY_BYTES = 1_000_000;

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
  const { auth, database } = options;
  const origin = new URL(options.baseUrl).origin;
  const api = new Hono();

  // Better Auth owns the routing below this path (ADR 0006); Braivo still owes
  // it the protections. Unguarded, `sign-up/email` accepts a megabytes-long
  // name unauthenticated, and `organization/list` answers with one caller's
  // organizations under no cache header at all.
  api.on(
    ["GET", "POST"],
    "/api/auth/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      const answered = await auth.handler(context.req.raw);

      // Set on every answer, not only the ones Better Auth leaves bare: nothing
      // under this mount is public with the plugins in use, and exempting a
      // header that already said `no-store` only ever skipped this same value.
      const headers = new Headers(answered.headers);
      headers.set("cache-control", "private, no-store");

      return new Response(answered.body, {
        status: answered.status,
        statusText: answered.statusText,
        headers,
      });
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

    for (const cookie of headers.getSetCookie()) {
      context.header("set-cookie", cookie, { append: true });
    }
    return response;
  }

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

  /**
   * Where a learner stands on each objective in a course, for a content owner.
   *
   * The learner is named in the path, as the evidence route names one, because
   * the reader is someone else. Who that reader is comes from the session and is
   * never named; whether they may read it is decided by the use case.
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
      if (!isTrustedWrite(context, origin)) return context.body(null, 403);

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
   * Registers learning targets for an organization.
   *
   * Objectives are the vocabulary evidence and courses are written against, and
   * until content can be derived from source material a content owner has to
   * say what they are. Before this route they could only be created by writing
   * to the database.
   */
  api.post(
    "/api/organizations/:organizationId/objectives",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (context) => context.body(null, 413) }),
    async (context) => {
      if (!isTrustedWrite(context, origin)) return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const titles = parseTitles(await context.req.json().catch(() => undefined));
      if (titles === undefined) return context.body(null, 400);

      try {
        const objectiveIds = await defineObjectives({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          titles,
        });

        return context.json({ objectiveIds }, 201);
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
      if (!isTrustedWrite(context, origin)) return context.body(null, 403);

      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);

      const course = parseCourse(await context.req.json().catch(() => undefined));
      if (course === undefined) return context.body(null, 400);

      try {
        const courseId = await defineCourse({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: session.user.id,
          title: course.title,
          objectiveIds: course.objectiveIds,
        });

        return context.json({ courseId }, 201);
      } catch (error) {
        if (error instanceof NotPermitted) return context.body(null, 403);
        throw error;
      }
    },
  );

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

  return api;
}

export type Api = ReturnType<typeof createApi>;
