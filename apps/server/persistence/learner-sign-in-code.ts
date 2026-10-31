// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { learnerSession, learnerSignInCode, organizationDomain, user } from "@braivo/db/schema";
import { and, eq, gt, lt, lte, sql } from "drizzle-orm";

// A learn domain's own sign-in codes (ADR 0018), one row per hostname and
// address: the code's seed until spent, and the minute between codes.

/**
 * Stores a code for `email` on `hostname`, unless one was sent less than a
 * minute ago, renewing `expiresAt` and `resendAt` either way: the one it
 * holds while it still signs in (unspent, unexpired, guessed wrong fewer than
 * `attempts` times, for the same organization), its guesses kept, else
 * `codeSeed`'s. Answers the seed to send, or `undefined` within the minute.
 * One statement, so two requests at once cannot both send. Forgets every
 * expired code first, as nothing else would remove them.
 */
export async function storeLearnerSignInCode(
  database: Database,
  input: {
    hostname: string;
    email: string;
    organizationId: string;
    codeSeed: string;
    attempts: number;
    expiresAt: Date;
    resendAt: Date;
    at: Date;
  },
): Promise<string | undefined> {
  const { at, attempts, ...code } = input;
  await database.delete(learnerSignInCode).where(lte(learnerSignInCode.expiresAt, at));
  // Read before the update, as all of SET is.
  const holds = sql`(${learnerSignInCode.codeSeed} is not null
    and ${learnerSignInCode.expiresAt} > ${at}
    and ${learnerSignInCode.attempts} < ${attempts}
    and ${learnerSignInCode.organizationId} = excluded.organization_id)`;
  const [stored] = await database
    .insert(learnerSignInCode)
    .values({ ...code, attempts: 0 })
    .onConflictDoUpdate({
      target: [learnerSignInCode.hostname, learnerSignInCode.email],
      set: {
        organizationId: code.organizationId,
        codeSeed: sql`case when ${holds} then ${learnerSignInCode.codeSeed} else excluded.code_seed end`,
        attempts: sql`case when ${holds} then ${learnerSignInCode.attempts} else 0 end`,
        expiresAt: code.expiresAt,
        resendAt: code.resendAt,
      },
      setWhere: lte(learnerSignInCode.resendAt, at),
    })
    .returning({ codeSeed: learnerSignInCode.codeSeed });
  return stored?.codeSeed ?? undefined;
}

export type CheckedCode =
  | { kind: "right"; organizationId: string; codeSeed: string }
  /** None, spent, or expired: answered as Better Auth's `OTP_EXPIRED`, asking for a new one. */
  | { kind: "expired" }
  | { kind: "wrong" }
  /** Guessed `attempts` times already: it signs in no more. */
  | { kind: "guessed-out" };

/**
 * Checks the code `email` holds on `hostname`, by `isCode` given its seed,
 * counting a wrong guess. Locked while checked, so guesses at once each
 * count. A right one is not spent: `spendLearnerSignInCode` does that, with
 * the session, checking again what may have changed meanwhile.
 */
export async function checkLearnerSignInCode(
  database: Database,
  input: {
    hostname: string;
    email: string;
    isCode: (codeSeed: string) => boolean;
    attempts: number;
    at: Date;
  },
): Promise<CheckedCode> {
  const key = and(
    eq(learnerSignInCode.hostname, input.hostname),
    eq(learnerSignInCode.email, input.email),
  );
  return database.transaction(async (transaction) => {
    const [row] = await transaction.select().from(learnerSignInCode).where(key).for("update");
    if (!row?.codeSeed || row.expiresAt <= input.at) return { kind: "expired" };
    if (row.attempts >= input.attempts) return { kind: "guessed-out" };
    if (input.isCode(row.codeSeed)) {
      return { kind: "right", organizationId: row.organizationId, codeSeed: row.codeSeed };
    }

    const attempts = row.attempts + 1;
    await transaction.update(learnerSignInCode).set({ attempts }).where(key);
    return attempts >= input.attempts ? { kind: "guessed-out" } : { kind: "wrong" };
  });
}

/**
 * Spends the code checked right, opening the learner session it signs in to,
 * in one transaction, and only while everything checked still holds: the
 * same code (its seed), unexpired now, guessed wrong fewer than `attempts` times
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
    codeSeed: string;
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
      .set({ codeSeed: null })
      .where(
        and(
          key,
          eq(learnerSignInCode.codeSeed, input.codeSeed),
          eq(learnerSignInCode.organizationId, input.organizationId),
          // The clock as this runs, not the request's, nor `now()`, which is
          // the transaction's start: a code may expire while its account is
          // found, or while this waited for its row.
          gt(learnerSignInCode.expiresAt, sql`clock_timestamp()`),
          lt(learnerSignInCode.attempts, input.attempts),
          // Locked, as `handoffDomainHolds` is, for a removal of the domain.
          sql`exists (
            select 1 from ${organizationDomain}
            where ${organizationDomain.hostname} = ${learnerSignInCode.hostname}
              and ${organizationDomain.organizationId} = ${learnerSignInCode.organizationId}
            for key share
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
