// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { readOrganizationRoles } from "../persistence/index.ts";

/**
 * Not permitted for the named organization: the actor may not act on it, or the
 * learner or content named is not its own. One class for every use case; the message says
 * what was refused.
 */
export class NotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPermitted";
  }
}

/**
 * Roles that administer an organization: its people, groups, settings, every
 * learner's progress, and evidence recorded for learners. A learner is a
 * `member`, so membership alone must not be enough: evidence is what every
 * estimate is rebuilt from, and a learner must not award themselves successes.
 */
const ADMINISTERING_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Roles that manage the organization's learning content, its material,
 * objectives, tasks, and courses, publishing included (ADR 0048). `author`
 * grants that alone: no person's data, no evidence, no settings.
 */
const AUTHORING_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "author"]);

/**
 * Whether this user may administer this organization, for a caller that
 * answers a refusal some other way than with `NotPermitted` — one that must
 * not reveal the organization is there at all, say.
 */
export async function mayAdminister(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  return administers(await readOrganizationRoles(database, input));
}

/** Whether these roles, one member's in one organization, administer it. */
export function administers(roles: readonly string[]): boolean {
  return roles.some((role) => ADMINISTERING_ROLES.has(role));
}

/** Whether this user may manage this organization's learning content. */
export async function mayAuthor(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  return authors(await readOrganizationRoles(database, input));
}

/** Whether these roles, one member's in one organization, manage its content. */
export function authors(roles: readonly string[]): boolean {
  return roles.some((role) => AUTHORING_ROLES.has(role));
}

/**
 * Whether this user belongs to this organization, in any role. For a learner
 * that is enrollment in every course the organization has (ADR 0018).
 */
export async function isMember(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  return (await readOrganizationRoles(database, input)).length > 0;
}

/**
 * Refuses unless this user may administer this organization. `organizationId`
 * comes from the caller and proves nothing by itself, which is why the actor
 * is checked against it (docs/adr/0006-better-auth.md).
 */
export async function assertMayAdminister(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<void> {
  if (!(await mayAdminister(database, input))) {
    throw new NotPermitted(
      `"${input.userId}" may not administer organization "${input.organizationId}".`,
    );
  }
}

/** Refuses unless this user may manage this organization's learning content, as `assertMayAdminister`. */
export async function assertMayAuthor(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<void> {
  if (!(await mayAuthor(database, input))) {
    throw new NotPermitted(
      `"${input.userId}" may not author in organization "${input.organizationId}".`,
    );
  }
}
