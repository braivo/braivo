// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { toolsMayReadLearnerData } from "../persistence/index.ts";

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
 * while the organization allows it. Read from the database on every call,
 * never cached, so switching it off refuses a token's next request. Pass the
 * organization owning what is read, never one the request names.
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
