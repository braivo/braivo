// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, assessKnowledge, type ObjectiveStanding, replay } from "../learning/index.ts";
import {
  readCourseObjectives,
  readCourseOrganization,
  readMembers,
  readMembersEvidence,
  readObjectiveTitles,
  readTaughtLearners,
} from "../persistence/index.ts";
import { type AccessKind, mayReadLearnerData } from "./access.ts";
import { hostAdmits, type RequestHost } from "./host.ts";
import { mayAdminister } from "./permission.ts";

/**
 * Where each learner in a course stands, counted (docs/specs/progress.md): per
 * learner, and per objective (knowledge gaps across learners). For whoever
 * administers the organization, the learners are every member, as membership
 * is enrollment (ADR 0018); for a teacher, the learners of the groups they
 * teach that take the course (ADR 0042). Each is counted from what
 * `readLearnerProgress` would report about them at `now`.
 *
 * Checked as `loadLearnerInCourse` checks a reader, minus reading for oneself:
 * no member sees others they do not teach, and a tool none unless the
 * organization allows it (ADR 0050).
 */
export async function readCourseProgress(input: {
  database: Database;
  /** The signed-in actor asking. */
  viewedBy: string;
  /** How they came: an overview names others, so a tool reads it only where allowed. */
  accessKind: AccessKind;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
}): Promise<CourseProgress> {
  const { database, viewedBy, accessKind, courseId, host, now } = input;

  // Open or not: whoever reads it here reads for the learners.
  const course = await readCourseOrganization(database, courseId);
  if (course === undefined) return { kind: "unavailable" };
  const { organizationId, open } = course;
  if (!(await hostAdmits(database, host, organizationId))) return { kind: "unavailable" };
  if (!(await mayReadLearnerData(database, { organizationId, accessKind }))) {
    return { kind: "unavailable" };
  }
  // `undefined` for every member: an administrator's view.
  let taught: CourseLearner[] | undefined;
  if (!(await mayAdminister(database, { organizationId, userId: viewedBy }))) {
    taught = await readTaughtLearners(database, { teacherId: viewedBy, courseId });
    if (taught === undefined) return { kind: "unavailable" };
  }

  const [[objectiveIds, titles], members, evidence] = await Promise.all([
    readCourseObjectives(database, courseId).then(
      async (ids) => [ids, await readObjectiveTitles(database, ids)] as const,
    ),
    taught ?? readMembers(database, organizationId),
    readMembersEvidence(
      database,
      organizationId,
      now,
      taught?.map(({ userId }) => userId),
    ),
  ]);

  const assessed = members.map((member) => ({
    member,
    standings: assessKnowledge({
      now,
      objectiveIds,
      estimates: replay(evidence.get(member.userId) ?? [], activeModel),
      model: activeModel,
    }).objectives,
  }));
  const byObjective = Map.groupBy(
    assessed.flatMap(({ standings }) => standings),
    (standing) => standing.objectiveId,
  );

  return {
    kind: "assessed",
    overview: {
      open,
      modelVersion: activeModel.version,
      learners: assessed.map(({ member, standings }) => ({
        ...member,
        standings: countStandings(standings),
      })),
      objectives: objectiveIds.map((objectiveId) => {
        const title = titles.get(objectiveId);
        // Never missing: the course references it, with deletes restricted.
        if (title === undefined)
          throw new Error(`Objective ${objectiveId} of course ${courseId} is missing`);
        return {
          objectiveId,
          title,
          standings: countStandings(byObjective.get(objectiveId) ?? []),
        };
      }),
    },
  };
}

/** A learner as the overview names them: `roles` only for whoever administers it (access-26). */
type CourseLearner = { userId: string; name: string; roles?: string[] };

/** Standings counted; `retained` is retaining and not due. */
type StandingCounts = { unseen: number; acquiring: number; retained: number; due: number };

function countStandings(standings: readonly ObjectiveStanding[]): StandingCounts {
  const counts = { unseen: 0, acquiring: 0, retained: 0, due: 0 };
  for (const standing of standings) {
    if (standing.phase !== "retaining") counts[standing.phase]++;
    else if (standing.due) counts.due++;
    else counts.retained++;
  }
  return counts;
}

/**
 * The course's learners as the reader may see them, by name, with their
 * objectives counted; and every objective of the course, in content order,
 * with those learners counted. Both count the same learner-objective
 * standings. `open`, published and not hidden, so a teacher is not sent to
 * a link no learner reaches (ADR 0039).
 */
export type CourseProgressOverview = {
  open: boolean;
  modelVersion: string;
  learners: (CourseLearner & { standings: StandingCounts })[];
  objectives: { objectiveId: string; title: string; standings: StandingCounts }[];
};

/** `unavailable` answers a missing course and a refused reader alike, as `LearnerProgress` does. */
type CourseProgress =
  | { kind: "unavailable" }
  | { kind: "assessed"; overview: CourseProgressOverview };
