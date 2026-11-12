// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  deleteLearnerHistory,
  type ErasureCounts,
  type ErasureScope,
  isOnlyOwner,
  readErasurePreview,
  readOrganizationBySlug,
  withLearnerHistoryLock,
} from "../persistence/index.ts";
import {
  type ErasureLog,
  type ErasureRecord,
  markErasureDone,
  type OrganizationErasure,
  writeErasureIntent,
} from "./erasure-log.ts";
import { readConfirmedUserIdByEmail } from "./unconfirmed-email.ts";

export type { ErasureCounts };

export type HistoryErasureTarget = ErasureScope & { organizationSlug: string };

/**
 * Who `email` and `organizationSlug` name, and what erasing would remove, for
 * the operator to confirm; or an `Error` whose message the CLI prints. Someone
 * this organization has no trace of is refused, so no fence is written naming a
 * stranger.
 */
export async function previewHistoryErasure(input: {
  database: Database;
  email: string;
  organizationSlug: string;
}): Promise<{ target: HistoryErasureTarget; counts: ErasureCounts; epoch: number }> {
  const { database, organizationSlug } = input;
  // As sign-in stores it (access-1): Better Auth lowercases, after trimming here.
  const email = input.email.trim().toLowerCase();

  const organization = await readOrganizationBySlug(database, organizationSlug);
  if (organization === undefined) {
    throw new Error(`No organization has the slug ${organizationSlug}.`);
  }
  const learnerId = await readConfirmedUserIdByEmail(database, email);
  if (learnerId === undefined) throw new Error(`No account has the email ${email}.`);

  const { counts, epoch, known } = await readErasurePreview(database, {
    learnerId,
    organizationId: organization.id,
    email,
  });
  if (!known) throw new Error(`${email} has nothing recorded at ${organizationSlug}.`);
  return {
    target: { learnerId, email, organizationId: organization.id, organizationSlug },
    counts,
    epoch,
  };
}

/**
 * Erases one learner's history at one organization, and fences it against old
 * answers (access-48): all or nothing, under the lock every writer takes.
 *
 * The log's intent is written under that lock once nothing can refuse, before
 * anything is deleted: a failed write erases nothing, a crash leaves a pending
 * intent, never an unrecorded erasure, and a refusal leaves no intent for a
 * replay to carry out. A failure after it may yet have committed, so the error
 * names the record and its epoch, for the operator to compare with what the
 * command next shows. Resolves once the record is marked done, after commit.
 */
export async function eraseLearnerHistory(input: {
  database: Database;
  target: HistoryErasureTarget;
  endMembership: boolean;
  log: ErasureLog;
}): Promise<{
  recordId: string;
  epoch: number;
  removed: ErasureCounts & { membership: boolean };
}> {
  const { database, target, endMembership, log } = input;
  const { learnerId, organizationId, email, organizationSlug } = target;

  let pending: ErasureRecord<OrganizationErasure> | undefined;
  const { record, removed } = await withLearnerHistoryLock(
    database,
    target,
    async (transaction, history) => {
      if (endMembership && (await isOnlyOwner(transaction, target))) {
        throw new Error(
          `${email} is the only owner of ${organizationSlug}; give it another owner, with organization make-owner --slug ${organizationSlug} --email <successor>, or leave --end-membership out. Nothing was erased.`,
        );
      }
      const epoch = history.epoch + 1;
      const record = await writeErasureIntent(
        log,
        { scope: "organization", userId: learnerId, organizationId, epoch, endMembership },
        email,
      );
      pending = record;
      const removed = await deleteLearnerHistory(transaction, target, { epoch, endMembership });
      return { record, removed };
    },
  ).catch((error: unknown) => {
    if (pending === undefined) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${why}\nLog record ${pending.id} is pending, for history epoch ${pending.epoch}.`,
    );
  });

  await markErasureDone(log, record);
  return { recordId: record.id, epoch: record.epoch, removed };
}
