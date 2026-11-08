// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";

import {
  chooseNextActivity,
  chooseNextObjective,
  isTimeZone,
  listLearnerCourses,
  listLearnerCoursesWithStanding,
  parseTaskReport,
  readCourseProgress,
  readLearnerProgress,
  reportAttempt,
  reviewObjective,
  submitAttempt,
  withoutHistory,
} from "../application/index.ts";
import { parseCourseNumber } from "../content/index.ts";
import { type Guards, isHistoryEpoch, jsonBody } from "./guards.ts";
import { historyErasedRefusal, secondsUntil } from "./refusals.ts";

/**
 * Reads an attempt's envelope out of a request body. The response inside it is
 * the task's to judge, so it passes through unread: only the use case knows
 * which task it answers.
 */
function parseAttempt(body: unknown):
  | {
      id: string;
      taskId: string;
      response: unknown;
      historyEpoch: number;
      reviewedTeaching: boolean;
    }
  | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const {
    id,
    taskId,
    response,
    historyEpoch,
    reviewedTeaching = false,
  } = body as Record<string, unknown>;
  if (typeof id !== "string") return undefined;
  if (typeof taskId !== "string" || taskId === "") return undefined;
  if (!isHistoryEpoch(historyEpoch)) return undefined;
  // Absent is `false`, so a client that never reviews need not send it.
  if (typeof reviewedTeaching !== "boolean") return undefined;

  return { id, taskId, response, historyEpoch, reviewedTeaching };
}

/**
 * The `timeZone` a learner's day is counted in, an IANA name; UTC when the
 * request names none, `undefined` when it names one that does not exist.
 */
function parseTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return "UTC";
  return isTimeZone(value) ? value : undefined;
}

/**
 * What a learner studies: their courses, what to do next in one, answering its
 * tasks, and where they stand, with the overview a content owner reads.
 */
export function learningRoutes(
  { requestHost, trustedJsonWrite, requireAccount, requireLearner }: Guards,
  { database }: { database: Database },
) {
  const routes = new Hono();

  /**
   * What the signed-in learner should do next in a course. The learner is the
   * session's user, never a value from the request, so there is nothing to
   * authorize and nothing to get wrong.
   */
  routes.get("/api/courses/:courseId/next", requireLearner, async (context) => {
    const timeZone = parseTimeZone(context.req.query("timeZone"));
    if (timeZone === undefined) return context.body(null, 400);

    const next = await chooseNextObjective({
      database,
      learnerId: context.var.learner.id,
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now: new Date(),
      timeZone,
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
      // Not caught up: nothing was ever there to finish.
      case "empty":
        return context.json({ empty: true });
      case "daily-limit":
        return context.json({ dailyLimit: next.limit });
      case "decided":
        return context.json(next.decision);
      // A new answer added to `NextObjective` fails to compile here instead of
      // falling out of the switch as a response nobody chose.
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(next satisfies never)}`);
    }
  });

  /**
   * The courses the signed-in learner may study, from the session alone; with
   * `?number=`, the one so numbered, as a learn domain's `/c/4732` names it;
   * with `?standing=true`, each with where the learner stands in it and what
   * waits there, which a number's lookup, read on every course page, never pays
   * for, the day's limit counted in `timeZone`; with `?personal=true`, only
   * those of the personal organization the learner owns (ADR 0060).
   */
  routes.get("/api/courses", requireLearner, async (context) => {
    const numbered = context.req.query("number");
    const number = numbered === undefined ? undefined : parseCourseNumber(numbered);
    if (numbered !== undefined && number === undefined) return context.body(null, 400);
    const personalAsked = context.req.query("personal");
    if (personalAsked !== undefined && personalAsked !== "true") return context.body(null, 400);
    const personal = personalAsked === "true" ? (true as const) : undefined;
    const standing = context.req.query("standing");
    if (standing !== undefined) {
      if (standing !== "true" || numbered !== undefined || personal) return context.body(null, 400);
      const timeZone = parseTimeZone(context.req.query("timeZone"));
      if (timeZone === undefined) return context.body(null, 400);
      const courses = await listLearnerCoursesWithStanding({
        database,
        learnerId: context.var.learner.id,
        host: requestHost(context),
        now: new Date(),
        timeZone,
      });
      return context.json({ courses });
    }
    const courses = await listLearnerCourses({
      database,
      learnerId: context.var.learner.id,
      host: requestHost(context),
      number,
      personal,
    });
    return context.json({ courses });
  });

  /**
   * The signed-in learner's next objective, with a task to practise it or, while
   * every objective with a task that needs attention rests, when to ask again. Statuses as for the
   * decision route. `?objective=` decides among that objective of the course
   * alone, the learner's choice (docs/adr/0058-learner-chosen-objective.md).
   */
  routes.get("/api/courses/:courseId/activity", requireLearner, async (context) => {
    const timeZone = parseTimeZone(context.req.query("timeZone"));
    if (timeZone === undefined) return context.body(null, 400);

    const now = new Date();
    const next = await chooseNextActivity({
      database,
      learnerId: context.var.learner.id,
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now,
      timeZone,
      objectiveId: context.req.query("objective"),
    });

    switch (next.kind) {
      case "unavailable":
        return context.body(null, 404);
      case "empty":
        return context.json({ empty: true });
      case "caught-up":
        return context.body(null, 204);
      case "daily-limit":
        return context.json({ dailyLimit: next.limit });
      case "no-activity":
        return context.json({ decision: next.decision, objective: next.objective });
      case "resting":
        return context.json({
          objective: next.objective,
          retryAfter: secondsUntil(next.retryAt, now),
          reviewable: next.reviewable,
        });
      case "decided":
        return context.json({
          decision: next.decision,
          objective: next.objective,
          historyEpoch: next.historyEpoch,
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
  routes.post(
    "/api/courses/:courseId/attempts",
    ...trustedJsonWrite(),
    requireLearner,
    async (context) => {
      const attempt = parseAttempt(await jsonBody(context));
      if (attempt === undefined) return context.body(null, 400);

      const submitted = await submitAttempt({
        database,
        learnerId: context.var.learner.id,
        courseId: context.req.param("courseId"),
        host: requestHost(context),
        attemptId: attempt.id,
        taskId: attempt.taskId,
        response: attempt.response,
        historyEpoch: attempt.historyEpoch,
        reviewedTeaching: attempt.reviewedTeaching,
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
        case "history-erased":
          return historyErasedRefusal(context);
        case "graded": {
          const { grade, passages, reviewable } = submitted;
          // `passages` only when there are some, as `explanation` only when
          // the task has one: a hand-written task cites nothing.
          return context.json(
            passages.length > 0 ? { ...grade, passages, reviewable } : { ...grade, reviewable },
          );
        }
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(submitted satisfies never)}`);
      }
    },
  );

  /**
   * The passages the signed-in learner reviews an objective they answered on
   * by (ADR 0054). Answered as the activity is, 404 also for an objective
   * outside the course or not answered on yet; 204 when there is nothing to show.
   */
  routes.get(
    "/api/courses/:courseId/objectives/:objectiveId/review",
    requireLearner,
    async (context) => {
      const review = await reviewObjective({
        database,
        learnerId: context.var.learner.id,
        courseId: context.req.param("courseId"),
        objectiveId: context.req.param("objectiveId"),
        host: requestHost(context),
        now: new Date(),
      });

      switch (review.kind) {
        case "unavailable":
          return context.body(null, 404);
        case "empty":
          return context.body(null, 204);
        case "review":
          return context.json({ title: review.title, passages: review.passages });
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(review satisfies never)}`);
      }
    },
  );

  /**
   * The signed-in learner reports a problem with a task they answered, by the
   * attempt (ADR 0052). A report is never changed: any other while one of the
   * task's is undismissed is refused with a code the learn app words.
   */
  routes.post(
    "/api/courses/:courseId/attempts/:attemptId/report",
    ...trustedJsonWrite(),
    requireLearner,
    async (context) => {
      // The note is the learner's own words: never logged.
      const report = parseTaskReport(await jsonBody(context));
      if (report === undefined) return context.body(null, 400);

      const reported = await reportAttempt({
        database,
        learnerId: context.var.learner.id,
        courseId: context.req.param("courseId"),
        host: requestHost(context),
        attemptId: context.req.param("attemptId"),
        report,
        now: new Date(),
      });

      switch (reported.kind) {
        case "unavailable":
          return context.body(null, 404);
        case "invalid":
          return context.body(null, 400);
        case "already-reported":
          return context.json(
            { error: "This task is already reported.", code: "ALREADY_REPORTED" },
            409,
          );
        case "stored":
          return context.json(reported.report, reported.created ? 201 : 200);
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(reported satisfies never)}`);
      }
    },
  );

  /**
   * Where a learner stands on each objective in a course, for a content owner
   * or the learner themselves.
   *
   * The learner is named in the path because the reader may be someone else. Who that reader is comes from the session
   * and is never named; whether they may read it is decided by the use case.
   */
  routes.get(
    "/api/courses/:courseId/learners/:learnerId/progress",
    requireLearner,
    async (context) => {
      const viewer = context.var.learner;
      // A learner session is a learner's, reading only its own; an
      // administrator reads others' on the installation's origin.
      const learnerId = context.req.param("learnerId");
      if (!requestHost(context).installation && learnerId !== viewer.id) {
        return context.body(null, 404);
      }
      // Only `false` leaves the history out; a misspelt or repeated value is
      // refused rather than read as the default, which would quietly send it all.
      const values = context.req.queries("includeHistory") ?? ["true"];
      if (values.length !== 1 || (values[0] !== "true" && values[0] !== "false")) {
        return context.body(null, 400);
      }
      const includeHistory = values[0] === "true";

      const progress = await readLearnerProgress({
        database,
        viewedBy: viewer.id,
        accessKind: context.var.accessKind,
        learnerId,
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
          return context.json(includeHistory ? progress.report : withoutHistory(progress.report));
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(progress satisfies never)}`);
      }
    },
  );

  /** Where each learner in a course stands, counted, for a content owner. */
  routes.get("/api/courses/:courseId/progress", requireAccount, async (context) => {
    const progress = await readCourseProgress({
      database,
      viewedBy: context.var.userId,
      accessKind: context.var.accessKind,
      courseId: context.req.param("courseId"),
      host: requestHost(context),
      now: new Date(),
    });

    switch (progress.kind) {
      case "unavailable":
        return context.body(null, 404);
      case "assessed":
        return context.json(progress.overview);
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(progress satisfies never)}`);
    }
  });

  return routes;
}
