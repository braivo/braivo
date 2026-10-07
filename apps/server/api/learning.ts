// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";

import {
  chooseNextActivity,
  chooseNextObjective,
  listLearnerCourses,
  readCourseProgress,
  readLearnerProgress,
  submitAttempt,
} from "../application/index.ts";
import { type Guards, jsonBody } from "./guards.ts";
import { secondsUntil } from "./refusals.ts";

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
    const next = await chooseNextObjective({
      database,
      learnerId: context.var.learner.id,
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
  routes.get("/api/courses", requireLearner, async (context) => {
    const courses = await listLearnerCourses({
      database,
      learnerId: context.var.learner.id,
      host: requestHost(context),
    });
    return context.json({ courses });
  });

  /**
   * The signed-in learner's next objective, with a task to practise it or, while
   * its tasks rest, when to ask again. Statuses as for the decision route.
   */
  routes.get("/api/courses/:courseId/activity", requireLearner, async (context) => {
    const now = new Date();
    const next = await chooseNextActivity({
      database,
      learnerId: context.var.learner.id,
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

      const progress = await readLearnerProgress({
        database,
        viewedBy: viewer.id,
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
          return context.json(progress.report);
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
