// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { learnerSession, learnerSignInCode, organizationDomain, user } from "@braivo/db/schema";
import { and, eq, gt, lt, lte, sql } from "drizzle-orm";

// A learn domain's own sign-in codes (ADR 0018), one row per hostname and
// address: the code until spent, and the minute between codes.

/**
 * Stores a new code for `email` on `hostname`, replacing any it held, unless
 * one was sent less than a minute ago: answers whether it did. One statement,
 * so two requests at once cannot both send. Forgets every expired code first,
 * as nothing else would remove them.
 */
export async function storeLearnerSignInCode(
  database: Database,
  input: {
    hostname: string;
    email: string;
    organizationId: string;
    codeHash: string;
    expiresAt: Date;
    resendAt: Date;
    at: Date;
  },
): Promise<boolean> {
  const { at, ...code } = input;
  await database.delete(learnerSignInCode).where(lte(learnerSignInCode.expiresAt, at));
  const stored = await database
    .insert(learnerSignInCode)
    .values({ ...code, attempts: 0 })
    .onConflictDoUpdate({
      target: [learnerSignInCode.hostname, learnerSignInCode.email],
      set: {
        organizationId: code.organizationId,
        codeHash: code.codeHash,
        attempts: 0,
        expiresAt: code.expiresAt,
        resendAt: code.resendAt,
      },
      setWhere: lte(learnerSignInCode.resendAt, at),
    })
    .returning({ hostname: learnerSignInCode.hostname });
  return stored.length > 0;
}

export type CheckedCode =
  | { kind: "right"; organizationId: string }
  /** None, spent, or expired: answered as Better Auth's `OTP_EXPIRED`, asking for a new one. */
  | { kind: "expired" }
  | { kind: "wrong" }
  /** Guessed `attempts` times already: it signs in no more. */
  | { kind: "guessed-out" };

/**
 * Checks `codeHash` against the code `email` holds on `hostname`, counting a
 * wrong guess. Locked while checked, so guesses at once each count. A right
 * one is not spent: `spendLearnerSignInCode` does that, with the session,
 * checking again what may have changed meanwhile.
 */
export async function checkLearnerSignInCode(
  database: Database,
  input: { hostname: string; email: string; codeHash: string; attempts: number; at: Date },
): Promise<CheckedCode> {
  const key = and(
    eq(learnerSignInCode.hostname, input.hostname),
    eq(learnerSignInCode.email, input.email),
  );
  return database.transaction(async (transaction) => {
    const [row] = await transaction.select().from(learnerSignInCode).where(key).for("update");
    if (!row?.codeHash || row.expiresAt <= input.at) return { kind: "expired" };
    if (row.attempts >= input.attempts) return { kind: "guessed-out" };
    if (row.codeHash === input.codeHash) {
      return { kind: "right", organizationId: row.organizationId };
    }

    const attempts = row.attempts + 1;
    await transaction.update(learnerSignInCode).set({ attempts }).where(key);
    return attempts >= input.attempts ? { kind: "guessed-out" } : { kind: "wrong" };
  });
}

/**
 * Spends the code checked right, opening the learner session it signs in to,
 * in one transaction, and only while everything checked still holds: the
 * same code, unexpired now, guessed wrong fewer than `attempts` times
 * meanwhile, and the hostname still serving the organization it was sent
 * for. Answers whether it did. Keeps the row, whose minute between codes
 * still runs. Forgets every learner session already expired, as a handoff's
 * redemption does.
 */
export async function spendLearnerSignInCode(
  database: Database,
  input: {
    hostname: string;
    email: string;
    organizationId: string;
    codeHash: string;
    attempts: number;
    userId: string;
    at: Date;
    session: { tokenHash: string; expiresAt: Date };
  },
): Promise<boolean> {
  const key = and(
    eq(learnerSignInCode.hostname, input.hostname),
    eq(learnerSignInCode.email, input.email),
  );
  return database.transaction(async (transaction) => {
    // Locked first: an update waiting for the row would have judged it
    // before the wait, as its conditions are, so a code expiring meanwhile
    // would pass.
    await transaction.select().from(learnerSignInCode).where(key).for("update");
    const spent = await transaction
      .update(learnerSignInCode)
      .set({ codeHash: null })
      .where(
        and(
          key,
          eq(learnerSignInCode.codeHash, input.codeHash),
          eq(learnerSignInCode.organizationId, input.organizationId),
          // The clock as this runs, not the request's, nor `now()`, which is
          // the transaction's start: a code may expire while its account is
          // found, or while this waited for its row.
          gt(learnerSignInCode.expiresAt, sql`clock_timestamp()`),
          lt(learnerSignInCode.attempts, input.attempts),
          sql`exists (
            select 1 from ${organizationDomain}
            where ${organizationDomain.hostname} = ${learnerSignInCode.hostname}
              and ${organizationDomain.organizationId} = ${learnerSignInCode.organizationId}
          )`,
        ),
      )
      .returning({ hostname: learnerSignInCode.hostname });
    if (spent.length === 0) return false;

    await transaction.delete(learnerSession).where(lte(learnerSession.expiresAt, input.at));
    await transaction.insert(learnerSession).values({
      ...input.session,
      userId: input.userId,
      organizationId: input.organizationId,
      hostname: input.hostname,
    });
    return true;
  });
}

/**
 * Names `userId` `name`, only while the account has no name: a learn domain's
 * sign-in names a new account, never renames one. Answers whether it did.
 */
export async function nameUnnamedUser(
  database: Database,
  input: { userId: string; name: string; at: Date },
): Promise<boolean> {
  const named = await database
    .update(user)
    .set({ name: input.name, updatedAt: input.at })
    .where(and(eq(user.id, input.userId), sql`trim(${user.name}) = ''`))
    .returning({ id: user.id });
  return named.length > 0;
}
