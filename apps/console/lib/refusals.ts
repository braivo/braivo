// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { notFound } from "@tanstack/react-router";

import type { ConsoleAuth } from "./auth.ts";

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

/** An organization's members, or not found for someone outside it. */
export async function readMembers(auth: ConsoleAuth, organizationId: string) {
  const { data, error } = await auth.organization.listMembers({ query: { organizationId } });
  if (error) {
    if (error.status === 403 || error.status === 404) throw notFound();
    throw new Error(error.message ?? "Could not list the organization's members.");
  }
  return data.members;
}
