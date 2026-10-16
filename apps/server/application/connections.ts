// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Database } from "@braivo/db";

import {
  type Connection,
  deleteConnection,
  hasConsent,
  hasRefreshTokenConsent,
  readConnections,
} from "../persistence/index.ts";

// A remote MCP connection's grant (ADR 0045): one person, one client, one
// organization, standing until disconnected.

export type { Connection };

/**
 * Whether the grant a connection's token was issued under, at `issuedAt`,
 * still stands. Both are counted in whole seconds, so a token issued in the
 * second a disconnected grant is consented to again would pass.
 */
export function isConnectionStanding(
  database: Database,
  grant: { userId: string; clientId: string; organizationId: string; issuedAt: Date },
): Promise<boolean> {
  const { issuedAt: givenBy, ...connection } = grant;
  return hasConsent(database, { ...connection, givenBy });
}

/**
 * Whether a refresh token may mint tokens: Better Auth's refresh grant never
 * reads the consent, and its rotation marks the old token used, then inserts
 * the next, so a disconnect between the two would leave a chain standing
 * (access-42). Only a token of a standing grant, issued since it was given,
 * passes, in whole seconds as `isConnectionStanding`; one Braivo cannot find
 * passes, for Better Auth to refuse.
 *
 * Found as Better Auth 1.7.7 stores it (`storeTokens: "hashed"`, no prefix or
 * format): unpadded base64url SHA-256 of the token as sent. `mcp.test.ts`
 * fails if that changes, since no token would be found.
 */
export async function mayRefresh(database: Database, refreshToken: string): Promise<boolean> {
  const stored = createHash("sha256").update(refreshToken).digest("base64url");
  return (await hasRefreshTokenConsent(database, stored)) ?? true;
}

/** The apps a person connected, one per app and organization (access-42). */
export function listConnections(input: {
  database: Database;
  actingAs: string;
}): Promise<Connection[]> {
  return readConnections(input.database, input.actingAs);
}

/**
 * Ends one of a person's connections: its next call is refused though its
 * access token still verifies, and its refresh tokens mint no more (access-42).
 * `false` when they have none by that ID, another person's included.
 */
export function disconnectConnection(input: {
  database: Database;
  actingAs: string;
  connectionId: string;
}): Promise<boolean> {
  return deleteConnection(input.database, {
    userId: input.actingAs,
    connectionId: input.connectionId,
  });
}
