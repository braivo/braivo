// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { isUrlLabel } from "../content/index.ts";
import {
  type AuthoredTask,
  type CitedPassage,
  type Course,
  createCourse,
  findTasksOutsideOrganization,
  type ManagedCourse,
  markPublished,
  findObjectivesOutsideOrganization,
  readCourseObjectives,
  readCourses,
  readDomainOrganization,
  readLearnerCourses,
  readObjectiveCitations,
  readObjectiveTasks,
  readObjectiveTitles,
  readPublishedCoursesByObjective,
  readSources,
  type SourceSummary,
  updateCourseUrlLabel,
} from "../persistence/index.ts";
import type { RequestHost } from "./host.ts";
import { checkNames, InvalidDefinition } from "./objectives.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

/**
 * Creates a course over the organization's own objectives, in the order given;
 * that order is the candidate list selection works from.
 *
 * Ownership is checked here although composite foreign keys enforce it too, so a
 * foreign objective is a named refusal rather than a constraint violation. A
 * deletion racing the check still ends in that violation, and the schema still
 * refuses the row.
 */
export async function defineCourse(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor, who must be able to act on the organization. */
  actingAs: string;
  title: string;
  objectiveIds: readonly string[];
  /**
   * The caller's own name for the course, unique within the organization:
   * adding the same course again under it returns it (docs/adr/0024-idempotent-authoring.md).
   */
  key?: string;
  /**
   * Whether learners reach it at once: a person in the console reviewing it,
   * yes; a tool, no, it waits to be published (ADR 0039). One found under its
   * key keeps its state.
   */
  published: boolean;
}): Promise<string> {
  const { database, organizationId, actingAs, objectiveIds, key, published } = input;

  // Checked first, since it depends only on what was sent.
  const title = checkNames("The course", input);
  // Position orders an objective, so two would contradict; the database would
  // refuse the second as a constraint violation, a 500.
  const positions = new Map<string, number>();
  for (const [index, id] of objectiveIds.entries()) {
    const first = positions.get(id);
    if (first !== undefined) {
      throw new InvalidDefinition(
        "The course",
        `lists objective ${first} again as objective ${index}; a course lists each objective once`,
      );
    }
    positions.set(id, index);
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const outside = await findObjectivesOutsideOrganization(database, organizationId, objectiveIds);
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  return createCourse(database, { organizationId, title, objectiveIds, key, published });
}

/**
 * What a page showed is no longer there to publish: a course not in the
 * organization, or a task retired or corrected since. Reload and publish what it shows.
 */
export class StalePublication extends Error {
  constructor() {
    super(
      "A course or task to publish is no longer there to publish; reload the page and publish what it shows.",
    );
    this.name = "StalePublication";
  }
}

/**
 * Publishes the courses and tasks a person reviewed, all or none, so learners
 * reach them (ADR 0039): for whoever administers the organization, from the
 * console only, which the route decides. Publishing one already published
 * changes nothing; another organization's task refuses all, as on retiring.
 */
export async function publish(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  courseIds: readonly string[];
  taskIds: readonly string[];
  now: Date;
}): Promise<void> {
  const { database, organizationId, actingAs, courseIds, taskIds, now } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });

  // Checked apart from the write: a task never changes organization.
  const outside = await findTasksOutsideOrganization(database, organizationId, taskIds);
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }
  if (!(await markPublished(database, { organizationId, courseIds, taskIds, now }))) {
    throw new StalePublication();
  }
}

/**
 * Sets the label after a course's number in its links (ADR 0044), for whoever
 * administers its organization, if it is still `previous`, the label the
 * editor read: not saved, with the label now, when someone else changed it
 * meanwhile, which saving would undo unseen; `undefined` without such a course.
 */
export async function setCourseUrlLabel(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  courseId: string;
  urlLabel: string;
  previous: string;
}): Promise<{ saved: true } | { saved: false; urlLabel: string } | undefined> {
  const { database, organizationId, actingAs, courseId, urlLabel, previous } = input;
  if (!isUrlLabel(urlLabel)) {
    throw new InvalidDefinition(
      "The course's URL label",
      "takes lowercase letters and digits of any script with their marks, single hyphens between, at most 80 characters and 200 UTF-16 code units",
    );
  }

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return updateCourseUrlLabel(database, { organizationId, courseId, urlLabel, previous });
}

/** Every course an organization has, for whoever administers it. */
export async function listCourses(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<ManagedCourse[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readCourses(database, organizationId);
}

/**
 * The courses a learner may study: every course of every organization they
 * belong to, and on an organization's domain only that one's (ADR 0004).
 * Membership stands in for enrollment; this is the one place to change once
 * enrollment is defined.
 */
export async function listLearnerCourses(input: {
  database: Database;
  learnerId: string;
  host: RequestHost;
  /**
   * Only the course so numbered. A number is unique within an organization
   * alone, so on the installation's host, which serves them all, it names none.
   */
  number?: number;
}): Promise<Course[]> {
  const { database, learnerId, host, number } = input;
  if (host.installation) return number === undefined ? readLearnerCourses(database, learnerId) : [];

  const served = await readDomainOrganization(database, host.hostname);
  return served
    ? readLearnerCourses(database, learnerId, { organizationId: served.id, number })
    : [];
}

/**
 * A course as its content owner authored it: its objectives in the order
 * learners meet them, each with the passages that teach it and the tasks that
 * practise it — answers included, published or waiting — and the sources
 * those passages are from.
 */
export type AuthoredCourse = ManagedCourse & {
  objectives: {
    id: string;
    title: string;
    citations: CitedPassage[];
    tasks: AuthoredTask[];
    /**
     * The organization's other published courses it is in, which its tasks
     * reach too once published (ADR 0039: Publish names them).
     */
    otherPublishedCourses: { id: string; title: string }[];
  }[];
  /** Every source a passage above is from, once, by title. */
  sources: SourceSummary[];
};

/**
 * One of an organization's courses as authored, for whoever administers it,
 * or `undefined` when it has no such course: what reviewing a whole course —
 * in the console, or by an agent — reads, in one request.
 */
export async function readAuthoredCourse(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  courseId: string;
}): Promise<AuthoredCourse | undefined> {
  const { database, organizationId, actingAs, courseId } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  const course = (await readCourses(database, organizationId)).find(({ id }) => id === courseId);
  if (!course) return undefined;

  const objectiveIds = await readCourseObjectives(database, courseId);
  const titles = await readObjectiveTitles(database, objectiveIds);
  const published = await readPublishedCoursesByObjective(database, objectiveIds);
  // Two indexed reads per objective, all at once: a course is tens of them.
  const objectives = await Promise.all(
    objectiveIds.map(async (id) => ({
      id,
      title: titles.get(id) ?? "",
      citations: await readObjectiveCitations(database, id),
      tasks: await readObjectiveTasks(database, id),
      otherPublishedCourses: (published.get(id) ?? []).filter((other) => other.id !== courseId),
    })),
  );

  const cited = new Set(
    objectives.flatMap(({ citations, tasks }) => [
      ...citations.map(({ sourceId }) => sourceId),
      ...tasks.flatMap((task) => task.citations.map(({ sourceId }) => sourceId)),
    ]),
  );
  const sources = (await readSources(database, organizationId)).filter(({ id }) => cited.has(id));

  return { ...course, objectives, sources };
}
