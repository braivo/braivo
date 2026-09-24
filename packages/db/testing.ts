// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, inArray } from "drizzle-orm";

import { createDatabase, type Database } from "./database.ts";
import {
  attempt,
  course,
  learnerEvidence,
  member,
  objective,
  organization,
  task,
  user,
} from "./schema/index.ts";

// Test support for the suites that need a real database. Nothing here is part
// of the package's behaviour.
//
// Every helper is scoped to what a suite owns, so it only ever removes rows it
// created: `clearLearningData` to one organization, `clearLearnerHistory` to the
// learners listed. Truncating the shared tables instead would make each suite
// depend on the order the runner happens to choose.
//
// What this buys is order-independence, not concurrency: suites still share
// tables, which is why they run one file at a time.

let shared: Database | undefined;

/**
 * One connection pool per test file, however many modules in it ask.
 *
 * Vitest runs each file in a process of its own, one file at a time (see the
 * root `vite.config.ts`), so the pool closes when that process exits and the
 * run never holds more than one. Opening a pool per call instead, and never
 * closing it, is what once exhausted PostgreSQL's `max_connections` in
 * whichever suite happened to come last — a failure that read like a bug in
 * that suite and was arithmetic.
 *
 * The first caller's connection string wins and later ones are ignored, which
 * is correct only because every suite reads the same `TEST_DATABASE_URL`. A
 * suite wanting a different database needs its own pool and its own closing.
 */
export function sharedDatabase(connectionString: string): Database {
  shared ??= createDatabase(connectionString);
  return shared;
}

/**
 * Creates the organization and the memberships a suite owns, having first
 * removed what an earlier run left behind: its learning data, and every
 * membership in it. Safe to call repeatedly: every row is keyed by an ID the
 * suite chose rather than a generated one, and the memberships afterwards are
 * exactly the ones asked for.
 */
export async function seedOrganization(
  database: Database,
  options: {
    organizationId: string;
    learnerIds: readonly string[];
    /** Members who may act on the organization rather than only study in it. */
    adminIds?: readonly string[];
    at: Date;
  },
): Promise<void> {
  const { organizationId, learnerIds, adminIds = [], at } = options;

  await clearLearningData(database, organizationId);

  await database
    .insert(organization)
    .values({ id: organizationId, name: organizationId, slug: organizationId, createdAt: at })
    .onConflictDoNothing();

  // One membership per person. Someone listed as both is an admin, since that
  // is the role a suite listing them there means to test.
  const roles = new Map<string, string>();
  for (const id of learnerIds) roles.set(id, "member");
  for (const id of adminIds) roles.set(id, "admin");
  const people = [...roles].map(([id, role]) => ({ id, role }));

  // Replaced rather than merged: a role an earlier run left behind would
  // otherwise survive, and a test of a refusal could pass for the wrong reason.
  await database.delete(member).where(eq(member.organizationId, organizationId));
  if (people.length === 0) return;

  await database
    .insert(user)
    .values(
      people.map(({ id }) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: false,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .onConflictDoNothing();

  // Membership, and the role with it: someone who is not in the organization is
  // entitled to nothing in it, and someone who is only a `member` may study but
  // not grade. A suite that seeds neither is testing the refusal rather than the
  // behaviour it meant to.
  await database
    .insert(member)
    .values(
      people.map(({ id, role }) => ({
        id: `${organizationId}:${id}`,
        organizationId,
        userId: id,
        role,
        createdAt: at,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Stores a task and returns its generated ID. The body is stored as given: a
 * suite passes one the server's `content` module would accept.
 */
export async function createTask(
  database: Database,
  input: { organizationId: string; objectiveId: string; body: unknown; createdAt: Date },
): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(task).values({ id, ...input });
  return id;
}

/**
 * Removes an organization's objectives, courses, and tasks, with all evidence
 * and attempts recorded against them, whoever recorded them: the restricted
 * foreign keys refuse to delete what anything still points at.
 */
export async function clearLearningData(database: Database, organizationId: string): Promise<void> {
  const tasks = database
    .select({ id: task.id })
    .from(task)
    .where(eq(task.organizationId, organizationId));
  await database.delete(attempt).where(inArray(attempt.taskId, tasks));
  await database.delete(task).where(eq(task.organizationId, organizationId));

  await database
    .delete(learnerEvidence)
    .where(
      inArray(
        learnerEvidence.objectiveId,
        database
          .select({ id: objective.id })
          .from(objective)
          .where(eq(objective.organizationId, organizationId)),
      ),
    );

  await database.delete(course).where(eq(course.organizationId, organizationId));
  await database.delete(objective).where(eq(objective.organizationId, organizationId));
}

/** Removes just these learners' attempts and evidence, which most suites reset between tests. */
export async function clearLearnerHistory(
  database: Database,
  learnerIds: readonly string[],
): Promise<void> {
  if (learnerIds.length === 0) return;

  await database.delete(attempt).where(inArray(attempt.learnerId, learnerIds));
  await database.delete(learnerEvidence).where(inArray(learnerEvidence.learnerId, learnerIds));
}

/**
 * The constraint the database refused on. Drizzle wraps the driver error in one
 * that names only the query, so naming the constraint — rather than matching a
 * message — is what stops a test passing on an unrelated failure.
 */
export function violatedConstraint(error: unknown): string | undefined {
  return (error as { cause?: { constraint?: string } })?.cause?.constraint;
}
