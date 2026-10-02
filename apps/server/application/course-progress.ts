// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { activeModel, assessKnowledge, type ObjectiveStanding, replay } from "../learning/index.ts";
import {
  type Member,
  readCourseObjectives,
  readCourseOrganization,
  readMembers,
  readMembersEvidence,
  readObjectiveTitles,
} from "../persistence/index.ts";
import { hostAdmits, type RequestHost } from "./host.ts";
import { mayAdminister } from "./permission.ts";

/**
 * Where each learner in a course stands, counted, for a content owner
 * (docs/specs/progress.md): per learner, and per objective (knowledge gaps
 * across learners). The learners are every member, as membership is enrollment
 * (ADR 0018), each counted from what `readLearnerProgress` would report about
 * them at `now`.
 *
 * Checked as `loadLearnerInCourse` checks a reader, minus reading for oneself:
 * no member sees the others.
 */
export async function readCourseProgress(input: {
  database: Database;
  /** The signed-in actor asking. */
  viewedBy: string;
  courseId: string;
  /** The host the request came to, which limits the organizations reachable. */
  host: RequestHost;
  now: Date;
}): Promise<CourseProgress> {
  const { database, viewedBy, courseId, host, now } = input;

  const organizationId = await readCourseOrganization(database, courseId);
  if (organizationId === undefined) return { kind: "unavailable" };
  if (!(await hostAdmits(database, host, organizationId))) return { kind: "unavailable" };
  if (!(await mayAdminister(database, { organizationId, userId: viewedBy }))) {
    return { kind: "unavailable" };
  }

  const [[objectiveIds, titles], members, evidence] = await Promise.all([
    readCourseObjectives(database, courseId).then(
      async (ids) => [ids, await readObjectiveTitles(database, ids)] as const,
    ),
    readMembers(database, organizationId),
    readMembersEvidence(database, organizationId, now),
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
 * Every member of the course's organization, by name, with their objectives
 * counted; and every objective of the course, in content order, with its
 * learners counted. Both count the same learner-objective standings.
 */
export type CourseProgressOverview = {
  modelVersion: string;
  learners: (Member & { standings: StandingCounts })[];
  objectives: { objectiveId: string; title: string; standings: StandingCounts }[];
};

/** `unavailable` answers a missing course and a refused reader alike, as `LearnerProgress` does. */
type CourseProgress =
  | { kind: "unavailable" }
  | { kind: "assessed"; overview: CourseProgressOverview };
