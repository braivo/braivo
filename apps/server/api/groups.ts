// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";

import {
  changeGroup,
  defineGroup,
  type GroupChange,
  type GroupDefinition,
  listGroups,
} from "../application/index.ts";
import { type Guards, jsonBody } from "./guards.ts";
import { organizationRefusal } from "./refusals.ts";

/** How many people, or courses, one list in a request may hold: a class, with room to spare. */
const MAX_IDS_PER_LIST = 1000;

/** A list of IDs, or `undefined` when it is not one. */
function parseIds(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length <= MAX_IDS_PER_LIST &&
    value.every((id) => typeof id === "string" && id !== "")
    ? (value as string[])
    : undefined;
}

/** An object holding only `allowedKeys`, or `undefined`: a misspelt one would otherwise change nothing, unnoticed. */
function parseStrictObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a group's creation out of a request body: only the types. */
function parseDefinition(body: unknown): { key?: string; definition: GroupDefinition } | undefined {
  const fields = parseStrictObject(body, ["name", "key", "learnerIds", "teacherIds", "courseIds"]);
  if (!fields) return undefined;
  const { name, key } = fields;
  const learnerIds = parseIds(fields.learnerIds);
  const teacherIds = parseIds(fields.teacherIds);
  const courseIds = parseIds(fields.courseIds);
  if (typeof name !== "string" || (key !== undefined && typeof key !== "string")) return undefined;
  if (!learnerIds || !teacherIds || !courseIds) return undefined;
  return { key, definition: { name, learnerIds, teacherIds, courseIds } };
}

/** Reads a change to a group out of a request body: only the types, each part optional. */
function parseChange(body: unknown): GroupChange | undefined {
  const fields = parseStrictObject(body, ["name", "add", "remove"]);
  // Only an omitted part is empty: `null` is refused, not read as nothing to do.
  const omittedAsEmpty = (value: unknown) => (value === undefined ? {} : value);
  const add = parseStrictObject(omittedAsEmpty(fields?.add), [
    "learnerIds",
    "teacherIds",
    "courseIds",
  ]);
  const remove = parseStrictObject(omittedAsEmpty(fields?.remove), ["userIds", "courseIds"]);
  if (!fields || !add || !remove) return undefined;
  if (fields.name !== undefined && typeof fields.name !== "string") return undefined;

  const parseOptionalIds = (value: unknown) => (value === undefined ? [] : parseIds(value));
  const [learnerIds, teacherIds, courseIds] = [add.learnerIds, add.teacherIds, add.courseIds].map(
    parseOptionalIds,
  );
  const [userIds, removedCourseIds] = [remove.userIds, remove.courseIds].map(parseOptionalIds);
  if (!learnerIds || !teacherIds || !courseIds || !userIds || !removedCourseIds) return undefined;
  return {
    name: fields.name,
    add: { learnerIds, teacherIds, courseIds },
    remove: { userIds, courseIds: removedCourseIds },
  };
}

/**
 * Groups: an organization's learners and teachers taking some of its courses
 * together, which scope what a teacher may read (ADR 0042). Created and
 * changed by whoever administers the organization; listed to them, and to
 * each teacher their own.
 */
export function groupRoutes(
  { trustedJsonWrite, requireAccount }: Guards,
  { database }: { database: Database },
) {
  const routes = new Hono();

  /** The organization's groups: all of them to an administrator, those they teach to anyone else. */
  routes.get("/api/organizations/:organizationId/groups", requireAccount, async (context) => {
    try {
      const groups = await listGroups({
        database,
        organizationId: context.req.param("organizationId"),
        actingAs: context.var.userId,
      });
      return context.json({ groups });
    } catch (error) {
      return organizationRefusal(context, error);
    }
  });

  /** Creates a group, or answers the one created the same under its `key` (ADR 0024). */
  routes.post(
    "/api/organizations/:organizationId/groups",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const parsed = parseDefinition(await jsonBody(context));
      if (!parsed) return context.body(null, 400);

      try {
        const groupId = await defineGroup({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          ...parsed,
        });
        return context.json({ groupId }, 201);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  /** Changes a group by what the body names, answering it as it then stands. */
  routes.post(
    "/api/organizations/:organizationId/groups/:groupId",
    ...trustedJsonWrite(),
    requireAccount,
    async (context) => {
      const change = parseChange(await jsonBody(context));
      if (!change) return context.body(null, 400);

      try {
        const group = await changeGroup({
          database,
          organizationId: context.req.param("organizationId"),
          actingAs: context.var.userId,
          groupId: context.req.param("groupId"),
          change,
        });
        return group ? context.json({ group }) : context.body(null, 404);
      } catch (error) {
        return organizationRefusal(context, error);
      }
    },
  );

  return routes;
}
