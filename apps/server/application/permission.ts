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
 * Roles that may author content and record evidence. A learner is a `member`, so
 * membership alone must not be enough: evidence is what every estimate is rebuilt
 * from, and a learner must not be able to award themselves successes.
 */
const ADMINISTERING_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Whether this user may act on this organization, for a caller that answers a
 * refusal some other way than with `NotPermitted` — one that must not reveal
 * the organization is there at all, say.
 */
export async function mayAdminister(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<boolean> {
  const roles = await readOrganizationRoles(database, input);
  return roles.some((role) => ADMINISTERING_ROLES.has(role));
}

/**
 * Refuses unless this user may act on this organization. `organizationId` comes
 * from the caller and proves nothing by itself, which is why the actor is checked
 * against it (docs/adr/0006-better-auth.md).
 */
export async function assertMayAdminister(
  database: Database,
  input: { organizationId: string; userId: string },
): Promise<void> {
  if (!(await mayAdminister(database, input))) {
    throw new NotPermitted(
      `"${input.userId}" may not act on organization "${input.organizationId}".`,
    );
  }
}
