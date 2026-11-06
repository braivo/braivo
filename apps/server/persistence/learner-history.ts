// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import {
  attempt,
  invitation,
  learnerEvidence,
  learnerHandoff,
  learnerHistoryState,
  learnerSession,
  learnerSignInCode,
  member,
  taskReport,
} from "@braivo/db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * One learner's history at one organization: what a record's ID is unique in,
 * and all a decision there may read (docs/adr/0032-learner-history.md).
 */
export type LearnerScope = { learnerId: string; organizationId: string };

/** `erasedAt` null means never erased, with no row: epoch 0, and no date to refuse by. */
type LearnerHistoryState = { epoch: number; erasedAt: Date | null };

/**
 * An answer or a result begun before this learner's history here was erased, or
 * that cannot show it was not: recording it would bring the history back
 * (docs/adr/0053-learners-data.md). Final, not a retry's to absorb.
 */
export class HistoryErased extends Error {
  constructor() {
    super(
      "Not recorded: this may predate an erasure of the learner's history here, or names an epoch that is not current.",
    );
    this.name = "HistoryErased";
  }
}

export async function readLearnerHistoryState(
  database: Database | Transaction,
  { learnerId, organizationId }: LearnerScope,
): Promise<LearnerHistoryState> {
  const [row] = await database
    .select({ epoch: learnerHistoryState.epoch, erasedAt: learnerHistoryState.erasedAt })
    .from(learnerHistoryState)
    .where(
      and(
        eq(learnerHistoryState.learnerId, learnerId),
        eq(learnerHistoryState.organizationId, organizationId),
      ),
    );
  return row ?? { epoch: 0, erasedAt: null };
}

/**
 * Runs `work` in a transaction holding this learner's history at this
 * organization still. Every writer of attempts or evidence and every erasure
 * runs in one, so a write lands wholly before an erasure, and is erased, or after
 * it, and sees its epoch. `work` reads what it decides by through `transaction`:
 * under READ COMMITTED, that includes whatever finished while this waited. Keyed
 * by the pair, as there may be no row yet.
 */
export async function withLearnerHistoryLock<T>(
  database: Database,
  scope: LearnerScope,
  work: (transaction: Transaction, history: LearnerHistoryState) => Promise<T>,
): Promise<T> {
  const { learnerId, organizationId } = scope;
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${learnerId}::text || ':' || ${organizationId}::text, 0))`,
    );
    return work(transaction, await readLearnerHistoryState(transaction, scope));
  });
}

/** Who an erasure at one organization is of: `email` as sign-in normalizes it. */
export type ErasureScope = LearnerScope & { email: string };

/** What an erasure at one organization removes, by kind of row. */
export type ErasureCounts = {
  attempts: number;
  evidence: number;
  reports: number;
  sessions: number;
  handoffs: number;
  signInCodes: number;
  invitations: number;
};

// Each row's predicate is here once, for both counting and deleting, so what
// the confirmation shows is what goes.
const matching = ({ learnerId, organizationId, email }: ErasureScope) => ({
  attempts: and(eq(attempt.learnerId, learnerId), eq(attempt.organizationId, organizationId)),
  evidence: and(
    eq(learnerEvidence.learnerId, learnerId),
    eq(learnerEvidence.organizationId, organizationId),
  ),
  reports: and(eq(taskReport.learnerId, learnerId), eq(taskReport.organizationId, organizationId)),
  sessions: and(
    eq(learnerSession.userId, learnerId),
    eq(learnerSession.organizationId, organizationId),
  ),
  handoffs: and(
    eq(learnerHandoff.userId, learnerId),
    eq(learnerHandoff.organizationId, organizationId),
  ),
  membership: and(eq(member.userId, learnerId), eq(member.organizationId, organizationId)),
  // Every hostname it served: `email` is stored lowercased.
  signInCodes: and(
    eq(learnerSignInCode.email, email),
    eq(learnerSignInCode.organizationId, organizationId),
  ),
  // Better Auth keeps an invitation's address as sent.
  invitations: and(
    eq(sql`lower(${invitation.email})`, email),
    eq(invitation.organizationId, organizationId),
  ),
});

/** What is there to erase, the epoch now, and whether anything names the person here at all. */
export async function readErasurePreview(
  database: Database,
  scope: ErasureScope,
): Promise<{ counts: ErasureCounts; epoch: number; known: boolean }> {
  const where = matching(scope);
  const [attempts, evidence, reports, sessions, handoffs, signInCodes, invitations] =
    await Promise.all([
      database.$count(attempt, where.attempts),
      database.$count(learnerEvidence, where.evidence),
      database.$count(taskReport, where.reports),
      database.$count(learnerSession, where.sessions),
      database.$count(learnerHandoff, where.handoffs),
      database.$count(learnerSignInCode, where.signInCodes),
      database.$count(invitation, where.invitations),
    ]);
  const counts = { attempts, evidence, reports, sessions, handoffs, signInCodes, invitations };
  const [membership, { epoch, erasedAt }] = await Promise.all([
    database.$count(member, where.membership),
    readLearnerHistoryState(database, scope),
  ]);
  return {
    counts,
    epoch,
    known: membership > 0 || erasedAt !== null || Object.values(counts).some((rows) => rows > 0),
  };
}

/**
 * Removes one learner's history at one organization and moves its fence to
 * `epoch`, in the caller's locked transaction (`withLearnerHistoryLock`). Reports
 * go by name, to be counted, though deleting their attempts would cascade.
 */
export async function deleteLearnerHistory(
  transaction: Transaction,
  scope: ErasureScope,
  options: { epoch: number; endMembership: boolean },
): Promise<ErasureCounts & { membership: boolean }> {
  const { learnerId, organizationId } = scope;
  const where = matching(scope);
  const rows = async (deleted: Promise<unknown[]>) => (await deleted).length;

  const reports = await rows(
    transaction.delete(taskReport).where(where.reports).returning({ id: taskReport.id }),
  );
  const attempts = await rows(
    transaction.delete(attempt).where(where.attempts).returning({ id: attempt.id }),
  );
  const evidence = await rows(
    transaction.delete(learnerEvidence).where(where.evidence).returning({ id: learnerEvidence.id }),
  );
  const sessions = await rows(
    transaction
      .delete(learnerSession)
      .where(where.sessions)
      .returning({ id: learnerSession.tokenHash }),
  );
  const handoffs = await rows(
    transaction.delete(learnerHandoff).where(where.handoffs).returning({ id: learnerHandoff.id }),
  );
  const signInCodes = await rows(
    transaction
      .delete(learnerSignInCode)
      .where(where.signInCodes)
      .returning({ hostname: learnerSignInCode.hostname }),
  );
  const invitations = await rows(
    transaction.delete(invitation).where(where.invitations).returning({ id: invitation.id }),
  );
  // Its groups go with it, by their foreign key.
  const ended = options.endMembership
    ? await rows(transaction.delete(member).where(where.membership).returning({ id: member.id }))
    : 0;

  // The database's clock, after the lock: outside evidence is compared with it,
  // and the command may run from any machine.
  const now = sql`clock_timestamp()`;
  await transaction
    .insert(learnerHistoryState)
    .values({ learnerId, organizationId, epoch: options.epoch, erasedAt: now })
    .onConflictDoUpdate({
      target: [learnerHistoryState.learnerId, learnerHistoryState.organizationId],
      set: { epoch: options.epoch, erasedAt: now },
    });

  return {
    attempts,
    evidence,
    reports,
    sessions,
    handoffs,
    signInCodes,
    invitations,
    membership: ended > 0,
  };
}
