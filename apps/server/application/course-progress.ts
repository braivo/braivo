// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  activeModel,
  assessKnowledge,
  type Misses,
  missesSinceSuccess,
  type ObjectiveStanding,
  REPEATED_MISSES_THRESHOLD,
  replay,
} from "../learning/index.ts";
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
import { lastPractised } from "./last-practised.ts";
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

  const inCourse = new Set(objectiveIds);

  const assessed = members.map((member) => {
    const history = evidence.get(member.userId) ?? [];
    // The instant alone: the console counts and dates it in the reader's zone (progress-17).
    const lastPractisedAt = lastPractised(history, inCourse, now) ?? null;
    const standings = assessKnowledge({
      now,
      objectiveIds,
      estimates: replay(history, activeModel),
      model: activeModel,
    }).objectives;
    // Repeated misses (progress-16): still learning, missed often enough since
    // the last success. The phase is checked though v1 implies it, so a model
    // where the two part never flags what is retained.
    const misses = missesSinceSuccess(history, now);
    const flagged = standings.flatMap(({ objectiveId, phase }) => {
      const missed = misses.get(objectiveId);
      return phase === "acquiring" && missed && missed.count >= REPEATED_MISSES_THRESHOLD
        ? [{ objectiveId, misses: missed }]
        : [];
    });
    return { member, standings, flagged, lastPractisedAt };
  });
  const byObjective = Map.groupBy(
    assessed.flatMap(({ standings }) => standings),
    (standing) => standing.objectiveId,
  );
  // Most misses first, then the latest; names, then IDs, keep ties stable.
  const flaggedByObjective = Map.groupBy(
    assessed
      .flatMap(({ member, flagged }) =>
        flagged.map(({ objectiveId, misses }) => ({
          objectiveId,
          learner: { userId: member.userId, name: member.name, misses },
        })),
      )
      .toSorted(
        ({ learner: a }, { learner: b }) =>
          b.misses.count - a.misses.count ||
          b.misses.lastMissAt.getTime() - a.misses.lastMissAt.getTime() ||
          a.name.localeCompare(b.name) ||
          (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
      ),
    ({ objectiveId }) => objectiveId,
  );

  return {
    kind: "assessed",
    overview: {
      open,
      modelVersion: activeModel.version,
      asOf: now,
      repeatedMissesThreshold: REPEATED_MISSES_THRESHOLD,
      learners: assessed.map(({ member, standings, flagged, lastPractisedAt }) => ({
        ...member,
        standings: countStandings(standings),
        repeatedMisses: flagged.length,
        lastPractisedAt,
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
          repeatedMisses: (flaggedByObjective.get(objectiveId) ?? []).map(({ learner }) => learner),
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

/** A learner with repeated misses on an objective, and those misses. */
type FlaggedLearner = { userId: string; name: string; misses: Misses };

/**
 * The course's learners as the reader may see them, by name, with their
 * objectives counted; and every objective of the course, in content order,
 * with those learners counted. Both count the same learner-objective
 * standings. `open`, published and not hidden, so a teacher is not sent to
 * a link no learner reaches (ADR 0039).
 *
 * Repeated misses (progress-16), from `repeatedMissesThreshold` misses on, assessed at
 * `asOf`: a learner counts their objectives with them, and an objective names
 * those learners, most misses first, so the two tally alike.
 *
 * Each learner's `lastPractisedAt` is as in their report (progress-17).
 */
export type CourseProgressOverview = {
  open: boolean;
  modelVersion: string;
  asOf: Date;
  repeatedMissesThreshold: number;
  learners: (CourseLearner & {
    standings: StandingCounts;
    repeatedMisses: number;
    lastPractisedAt: Date | null;
  })[];
  objectives: {
    objectiveId: string;
    title: string;
    standings: StandingCounts;
    repeatedMisses: FlaggedLearner[];
  }[];
};

/** `unavailable` answers a missing course and a refused reader alike, as `LearnerProgress` does. */
type CourseProgress =
  | { kind: "unavailable" }
  | { kind: "assessed"; overview: CourseProgressOverview };
