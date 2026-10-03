// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
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
 * An AI request, with a proxy's timeout explained. A proxy in front of Braivo
 * that waits less than the model may answers 504, or Cloudflare's 524, with no
 * reason of its own. The status cannot tell whether the model ran: if it did,
 * the request counted (docs/specs/generation.md, generation-13), and sent
 * unchanged it would likely spend another and be cut off again, so "try again"
 * is the wrong advice. Wrap only an AI request: an upload cut off spends none.
 */
export async function explainAiProxyTimeout<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
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
