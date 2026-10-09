// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";

import {
  citeSources,
  defineCourse,
  defineObjectives,
  defineTasks,
  listCourses,
  listManagedOrganizations,
  listMembers,
  listObjectiveCitations,
  listObjectives,
  listObjectiveTasks,
  readAuthoredCourse,
  recordGradedEvidence,
  type QuotedCitation,
  retireTasks,
  SetUpRefused,
  setUpOrganization,
} from "../application/index.ts";
import { type Auth, createOwnedOrganization } from "../auth/index.ts";
import type { Evidence } from "../learning/index.ts";
import { type Guards, jsonBody } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

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
 * Reads objectives out of a request body: each a title and, optionally, the
 * caller's key. Only the types: what each may be is the use case's rule.
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

    parsed.push(key === undefined ? { title } : { title, key });
  }
  return parsed;
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

/** Reads an organization's setup out of a request body: only the types. */
function parseSetup(body: unknown): { name: string; slug: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { name, slug } = body as Record<string, unknown>;
  if (typeof name !== "string" || typeof slug !== "string") return undefined;

  return { name, slug };
}

/** Reads a course out of a request body: only the types, as for objectives. */
function parseCourse(
  body: unknown,
): { title: string; objectiveIds: string[]; key?: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const { title, objectiveIds, key } = body as Record<string, unknown>;
  if (typeof title !== "string") return undefined;
  if (key !== undefined && typeof key !== "string") return undefined;

  if (!Array.isArray(objectiveIds)) return undefined;
  if (objectiveIds.length > MAX_ITEMS_PER_REQUEST) return undefined;

  const ids: string[] = [];
  for (const id of objectiveIds) {
    if (typeof id !== "string" || id === "") return undefined;
    ids.push(id);
  }

  return key === undefined ? { title, objectiveIds: ids } : { title, objectiveIds: ids, key };
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

/**
 * What a content owner builds and reads back under `/api/organizations`:
 * objectives, tasks, courses, and citations, the evidence a grader records,
 * and the organizations and members they manage.
 */
export function authoringRoutes(
  { trustedJsonWrite, requireAccount }: Guards,
  {
    auth,
    database,
    baseUrl,
    selfServeDomain,
  }: { auth: Auth; database: Database; baseUrl: string; selfServeDomain?: string },
) {
  const routes = new Hono();

  /**
   * Records what a learner did, on behalf of an organization. The organization
   * and the learner are named in the path because they are what is written to;
   * the grader is the session's user, never named, and whether they may grade
   * here is the use case's decision, not this route's. Its 403 probes nothing:
   * no learner or objective is looked up until the grader check passes.
   */
  routes.post(
    "/api/organizations/:organizationId/learners/:learnerId/evidence",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const evidence = parseEvidence(await jsonBody(context));
      if (evidence === undefined) return context.body(null, 400);

      try {
        await recordGradedEvidence({
          database,
          organizationId: context.req.param("organizationId"),
          gradedBy: context.var.userId,
          learnerId: context.req.param("learnerId"),
          evidence,
          now: new Date(),
        });
      } catch (error) {
        return organizationRefusal(context, error);
      }

      return context.body(null, 204);
    },
  );

  /**
   * Registers learning targets for an organization: the vocabulary evidence and
   * courses are written against.
   */
  routes.post(
    "/api/organizations/:organizationId/objectives",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const objectives = parseObjectives(await jsonBody(context));
      if (objectives === undefined) return context.body(null, 400);

      try {
        const objectiveIds = await defineObjectives({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          objectives,
        });

        return context.json({ objectiveIds }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * Adds tasks to the organization's objectives: what a learner answers, and
   * what the activity route offers them.
   */
  routes.post(
    "/api/organizations/:organizationId/tasks",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const tasks = parseTasks(await jsonBody(context));
      if (tasks === undefined) return context.body(null, 400);

      try {
        const taskIds = await defineTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          tasks,
          now: new Date(),
        });

        return context.json({ taskIds }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * Withdraws tasks from practice. A POST rather than a DELETE, because nothing
   * is deleted: the tasks stay, for the attempts that point at them.
   */
  routes.post(
    "/api/organizations/:organizationId/tasks/retire",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const taskIds = parseTaskIds(await jsonBody(context));
      if (taskIds === undefined) return context.body(null, 400);

      try {
        await retireTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          taskIds,
          now: new Date(),
        });
        return context.body(null, 204);
      } catch (error) {
        return organizationRefusal(context, error);
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
  routes.post(
    "/api/organizations/:organizationId/courses",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const course = parseCourse(await jsonBody(context));
      if (course === undefined) return context.body(null, 400);

      try {
        const courseId = await defineCourse({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          ...course,
        });

        return context.json({ courseId }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /** The organizations the session's user manages. */
  routes.get("/api/organizations", requireAccount, async (context) => {
    const organizations = await listManagedOrganizations({
      database,
      actingAs: context.var.userId,
    });
    return context.json({ organizations });
  });

  /**
   * Where an organization set up here would be served, for the console to
   * offer setting one up: `null` where the operator creates them (ADR 0018).
   */
  routes.get("/api/organization-setup", requireAccount, (context) =>
    context.json({ domain: selfServeDomain ?? null }),
  );

  /** Sets up an organization the session's user owns (ADR 0018). */
  routes.post("/api/organization-setup", ...trustedJsonWrite(), requireAccount, async (context) => {
    if (selfServeDomain === undefined) return context.body(null, 404);
    const setup = parseSetup(await jsonBody(context));
    if (!setup) return context.body(null, 400);

    try {
      const organization = await setUpOrganization({
        database,
        baseUrl,
        selfServeDomain,
        actingAs: context.var.userId,
        ...setup,
        create: (organization) => createOwnedOrganization(auth, organization),
      });
      return context.json({ organization }, 201);
    } catch (error) {
      if (!(error instanceof SetUpRefused)) throw error;
      return context.json({ error: error.message }, error.reason === "conflict" ? 409 : 400);
    }
  });

  /** Every member of an organization, for whoever administers it. */
  routes.get("/api/organizations/:organizationId/members", requireAccount, async (context) => {
    try {
      const members = await listMembers({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
      });

      return context.json({ members });
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  /**
   * One course as authored — objectives in order, each with its passages and
   * tasks, answers included — for whoever administers its organization.
   */
  routes.get(
    "/api/organizations/:organizationId/courses/:courseId",
    requireAccount,
    async (context) => {
      try {
        const course = await readAuthoredCourse({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
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
        return organizationRefusal(context, error);
      }
    },
  );

  /** Every course an organization has, for whoever administers it. */
  routes.get("/api/organizations/:organizationId/courses", requireAccount, async (context) => {
    try {
      const courses = await listCourses({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
      });

      return context.json({ courses });
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  /** Every objective an organization has defined, for whoever administers it. */
  routes.get("/api/organizations/:organizationId/objectives", requireAccount, async (context) => {
    try {
      const objectives = await listObjectives({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
      });

      return context.json({ objectives });
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  /**
   * Links objectives to the passages of sources that teach them. Braivo, not
   * the caller, decides where a quote is: that check is what makes derived
   * content grounded rather than merely attributed (ADR 0021).
   */
  routes.post(
    "/api/organizations/:organizationId/citations",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const citations = parseCitations(await jsonBody(context));
      if (citations === undefined) return context.body(null, 400);

      try {
        const located = await citeSources({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          citations,
        });

        return context.json({ citations: located });
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /** The passages an objective cites, for whoever administers its organization. */
  routes.get(
    "/api/organizations/:organizationId/objectives/:objectiveId/citations",
    requireAccount,
    async (context) => {
      try {
        const citations = await listObjectiveCitations({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          objectiveId: context.req.param("objectiveId"),
        });

        return citations ? context.json({ citations }) : context.body(null, 404);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /**
   * An objective's tasks still offered, as authored and with the passages they
   * cite, for whoever administers its organization: answers included, so
   * never a learner's.
   */
  routes.get(
    "/api/organizations/:organizationId/objectives/:objectiveId/tasks",
    requireAccount,
    async (context) => {
      try {
        const tasks = await listObjectiveTasks({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          objectiveId: context.req.param("objectiveId"),
        });
        if (!tasks) return context.body(null, 404);

        // The shape a task is authored in, so one read back can be sent again.
        return context.json({
          tasks: tasks.map(({ id, body, citations }) => ({ id, ...body, citations })),
        });
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  return routes;
}
