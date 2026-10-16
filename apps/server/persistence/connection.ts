// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { oauthClient, oauthConsent, oauthRefreshToken, organization } from "@braivo/db/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";

// A remote MCP connection is Better Auth's consent row, keyed by user, client,
// and reference ID, the organization chosen at consent (ADR 0045).

/**
 * Whether a person's consent to an OAuth client for one organization still
 * stands, given at `givenBy` or earlier: the stored grant a remote MCP
 * connection is. Disconnecting deletes it, and consenting again makes
 * another, which no earlier token reaches.
 */
export async function hasConsent(
  database: Database,
  input: { userId: string; clientId: string; organizationId: string; givenBy: Date },
): Promise<boolean> {
  const [row] = await database
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, input.userId),
        eq(oauthConsent.clientId, input.clientId),
        eq(oauthConsent.referenceId, input.organizationId),
        lte(oauthConsent.createdAt, input.givenBy),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether the refresh token stored as `storedToken` was issued under a grant
 * that still stands: a consent of its person, client, and organization given
 * by the token's creation at the latest, both in Better Auth's whole seconds.
 * So a successor a rotation inserts after a disconnect, or a token from
 * before the grant was given again, mints nothing. `undefined` for no such
 * token, which Better Auth refuses itself.
 */
export async function hasRefreshTokenConsent(
  database: Database,
  storedToken: string,
): Promise<boolean | undefined> {
  const [row] = await database
    .select({ consentId: oauthConsent.id })
    .from(oauthRefreshToken)
    .leftJoin(
      oauthConsent,
      and(
        eq(oauthConsent.userId, oauthRefreshToken.userId),
        eq(oauthConsent.clientId, oauthRefreshToken.clientId),
        eq(oauthConsent.referenceId, oauthRefreshToken.referenceId),
        gte(oauthRefreshToken.createdAt, oauthConsent.createdAt),
      ),
    )
    .where(eq(oauthRefreshToken.token, storedToken))
    .limit(1);
  return row && row.consentId !== null;
}

/** One of a person's connections: an app, the organization it works in, and since when. */
export type Connection = {
  /** The consent row's ID, which disconnecting names. */
  id: string;
  client: { id: string; name: string | null };
  organization: { id: string; name: string };
  connectedAt: Date;
};

/**
 * A person's connections, oldest first. One whose organization is gone is
 * left out: it reaches nothing, every call reading memberships.
 */
export async function readConnections(database: Database, userId: string): Promise<Connection[]> {
  const rows = await database
    .select({
      id: oauthConsent.id,
      clientId: oauthConsent.clientId,
      clientName: oauthClient.name,
      organizationId: organization.id,
      organizationName: organization.name,
      createdAt: oauthConsent.createdAt,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .innerJoin(organization, eq(organization.id, oauthConsent.referenceId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(asc(oauthConsent.createdAt), asc(oauthConsent.id));
  return rows.map((row) => ({
    id: row.id,
    client: { id: row.clientId, name: row.clientName },
    organization: { id: row.organizationId, name: row.organizationName },
    // Better Auth always sets it; the column is nullable only in its schema.
    connectedAt: row.createdAt ?? new Date(0),
  }));
}

/**
 * Deletes a person's connection, named by its consent row's ID, in one
 * transaction: every consent of that person, client, and organization, so
 * `/mcp` refuses its access tokens, and every refresh token, which Better
 * Auth's refresh grant would honour without a consent (their opaque access
 * tokens cascade). A successor a rotation inserts just after is refused by
 * `hasRefreshTokenConsent`. `false` when the person has no such connection.
 */
export function deleteConnection(
  database: Database,
  input: { userId: string; connectionId: string },
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [found] = await transaction
      .select({ clientId: oauthConsent.clientId, referenceId: oauthConsent.referenceId })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.id, input.connectionId), eq(oauthConsent.userId, input.userId)));
    if (!found?.referenceId) return false;
    const { clientId, referenceId } = found;
    await transaction
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, input.userId),
          eq(oauthConsent.clientId, clientId),
          eq(oauthConsent.referenceId, referenceId),
        ),
      );
    await transaction
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, input.userId),
          eq(oauthRefreshToken.clientId, clientId),
          eq(oauthRefreshToken.referenceId, referenceId),
        ),
      );
    return true;
  });
}
