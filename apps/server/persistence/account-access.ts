// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import {
  deviceCode,
  learnerHandoff,
  learnerSession,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@braivo/db/schema";
import { and, eq, ne } from "drizzle-orm";

/**
 * Ends every way into an account but the session `keep` names (ADR 0063):
 * its sessions and CLI tokens (Better Auth's `session`), learn domains'
 * learner sessions, handoffs it completed but no domain redeemed yet, device
 * codes it approved, and its connections' tokens and consents, so none
 * outlives a change of who the account is. An OAuth authorization code not
 * yet exchanged needs no delete: Better Auth (1.7.16) refuses its exchange
 * once its session is gone. One transaction, or part of the caller's.
 *
 * An identity being unlinked is deleted before this runs, never after: an
 * Apple sign-in in flight checks its link once its session exists
 * (`auth/native-sign-in.ts`), so either it finds the link gone or this
 * deletes its session.
 */
export async function endAccountAccess(
  database: Database | Transaction,
  input: { userId: string; keep?: string },
): Promise<void> {
  const { userId, keep } = input;
  await database.transaction(async (transaction) => {
    await transaction
      .delete(session)
      .where(
        keep === undefined
          ? eq(session.userId, userId)
          : and(eq(session.userId, userId), ne(session.token, keep)),
      );
    await transaction.delete(learnerSession).where(eq(learnerSession.userId, userId));
    await transaction.delete(learnerHandoff).where(eq(learnerHandoff.userId, userId));
    await transaction.delete(deviceCode).where(eq(deviceCode.userId, userId));
    await transaction.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    await transaction.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    await transaction.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
  });
}
