// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { toolsMayReadLearnerData } from "../persistence/index.ts";
import { NotPermitted } from "./permission.ts";

/**
 * How a request reached Braivo, from the credential it came with: a person's
 * `browser` session, or a `tool`'s, a device-flow token (ADR 0022) or a
 * connection (ADR 0045) alike, whatever is behind it. A use case reading
 * others' data takes it required, so a new caller cannot default to browser.
 */
export type AccessKind = "browser" | "tool";

/**
 * Whether `accessKind` may read what names or reports on members of this
 * organization other than the reader (ADR 0050): a browser always, a tool only
 * while the organization allows it. For a tool, read from the database on every
 * call, never cached, so switching it off refuses a token's next request. Pass the
 * organization owning what is read: a course's own, never one the request
 * names beside it; for an organization's route, the one its queries scope to.
 */
export async function mayReadLearnerData(
  database: Database,
  input: { organizationId: string; accessKind: AccessKind },
): Promise<boolean> {
  return (
    input.accessKind === "browser" ||
    (await toolsMayReadLearnerData(database, input.organizationId))
  );
}

/**
 * Refuses, as `NotPermitted`, what `mayReadLearnerData` would not admit: for a
 * route that refuses `403` rather than answering as missing (ADR 0050).
 */
export async function assertMayReadLearnerData(
  database: Database,
  input: { organizationId: string; accessKind: AccessKind },
): Promise<void> {
  if (!(await mayReadLearnerData(database, input))) {
    throw new NotPermitted(
      `Organization "${input.organizationId}" does not let tools read its learners' data.`,
    );
  }
}
