// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type BraivoClient,
  BraivoError,
  type Course,
  type Group,
  type Organization,
} from "@braivo/server/client";
import { notFound } from "@tanstack/react-router";

/**
 * A Braivo read whose refusal is the route's not-found page. Braivo answers a
 * missing resource and one this session may not see alike, and so does this.
 */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof BraivoError && (error.status === 403 || error.status === 404)) {
      throw notFound();
    }
    throw error;
  }
}

/**
 * A page's `beforeLoad` where only an `owner` or `admin` has anything: to
 * someone who teaches there it is not found, before anything is read
 * (access-39). Presentation alone: Braivo refuses them its reads either way.
 */
export function administratorsOnly({ context }: { context: { organization: Organization } }) {
  if (!context.organization.administers) throw notFound();
}

/**
 * A course, found through its organization's own listing, or not found. Braivo
 * authorizes a course by itself, so only this says the two halves of a URL
 * belong together: an owner of two organizations could otherwise pair one's
 * course with the other's objectives and members. Await it before whatever it
 * scopes — beside them it is not a gate.
 */
export async function readCourseInOrganization(
  braivo: BraivoClient,
  input: { organizationId: string; courseId: string; signal: AbortSignal },
) {
  const courses = await orNotFound(
    braivo.listCourses(input.organizationId, { signal: input.signal }),
  );
  const course = courses.find(({ id }) => id === input.courseId);
  if (!course) throw notFound();
  return course;
}

/**
 * The course a progress page reports on, checked to be the organization's
 * before any progress is read (progress-9). An administrator's, among its
 * courses; a teacher's, among those of the groups they teach, which come too:
 * the report's learners are theirs (access-39). Never an administrator's read
 * for a teacher, which Braivo would refuse.
 */
export async function readCourseForProgress(
  braivo: BraivoClient,
  input: { organization: Organization; courseId: string; signal: AbortSignal },
): Promise<{ course: Course; groups?: Group[] }> {
  const { organization, courseId, signal } = input;
  if (organization.administers) {
    return {
      course: await readCourseInOrganization(braivo, {
        organizationId: organization.id,
        courseId,
        signal,
      }),
    };
  }
  const groups = (await orNotFound(braivo.listGroups(organization.id, { signal }))).filter(
    ({ courses }) => courses.some(({ id }) => id === courseId),
  );
  const course = groups[0]?.courses.find(({ id }) => id === courseId);
  if (!course) throw notFound();
  return { course, groups };
}

/**
 * Braivo's AI being off, in an owner's terms: the server's words name the
 * operator's settings (generation-9), which are not theirs to change.
 */
export const AI_OFF_MESSAGE = "Braivo's AI is off for this organization.";

/**
 * An AI request, with failures a content owner cannot act on explained.
 *
 * No model, or one this organization may not use, though the listing said
 * otherwise: told by code, as a 501 may also be storage's.
 *
 * A proxy in front of Braivo that waits less than the model may answers 504,
 * or Cloudflare's 524, with no reason of its own. The status cannot tell
 * whether the model ran: if it did, the request counted (generation-13), and
 * sent unchanged it would likely spend another and be cut off again, so "try
 * again" is the wrong advice. Wrap only an AI request: an upload cut off
 * spends none.
 */
export async function explainAiFailure<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (
      error instanceof BraivoError &&
      (error.code === "AI_UNAVAILABLE" || error.code === "AI_NOT_ENTITLED")
    ) {
      throw new BraivoError(
        error.status,
        error.message,
        `${AI_OFF_MESSAGE} Ask whoever runs Braivo for you to turn it on.`,
        error.code,
      );
    }
    if (
      error instanceof BraivoError &&
      !error.reason &&
      (error.status === 504 || error.status === 524)
    ) {
      throw new BraivoError(
        error.status,
        error.message,
        "The request timed out before Braivo's AI answered. This may still use one of this month's AI requests. Less material may finish sooner; otherwise, ask whoever runs Braivo to allow AI requests up to five minutes.",
      );
    }
    throw error;
  }
}
