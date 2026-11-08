// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type AccountErasureCounts,
  type AffectedOrganization,
  deleteAccount,
  type PersonalOrganizationErasure,
  readAccountErasureCommitted,
  readAccountErasurePreview,
  readUserIdByEmail,
  withAccountLock,
} from "../persistence/index.ts";
import type { FileStore } from "../storage/index.ts";
import {
  type AccountErasureRecord,
  type ErasureLog,
  type ErasureRecord,
  markErasureDone,
  markErasureSuperseded,
  type ReadableErasureLog,
  readPendingAccountErasures,
  writeErasureIntent,
} from "./erasure-log.ts";
import { filesOf } from "./files.ts";

export type { AccountErasureCounts, AffectedOrganization, PersonalOrganizationErasure };

export type AccountErasureTarget = {
  /** Null when no account has the email, though rows may name it. */
  userId: string | null;
  email: string;
  organizations: AffectedOrganization[];
  /** Its personal organization, erased with it (ADR 0060); among `organizations` too. */
  personal: PersonalOrganizationErasure | null;
};

/** As sign-in stores it (access-1): Better Auth lowercases, after trimming here. */
function normalized(email: string): string {
  const trimmed = email.trim().toLowerCase();
  // A blank would match every row with an empty value, and an ended input as typed back.
  if (trimmed === "") throw new Error("An email address is required.");
  return trimmed;
}

/**
 * Who `email` names and what erasing them would remove, for the operator to
 * confirm. Not refused when no account has it: rows may name an address never
 * registered, and a second run must find nothing and change nothing.
 */
export async function previewAccountErasure(input: {
  database: Database;
  email: string;
}): Promise<{ target: AccountErasureTarget; counts: AccountErasureCounts }> {
  const { database } = input;
  const email = normalized(input.email);
  const userId = (await readUserIdByEmail(database, email)) ?? null;
  const { organizations, personal, counts } = await readAccountErasurePreview(database, {
    userId,
    email,
  });
  return { target: { userId, email, organizations, personal }, counts };
}

/** Said when a personal organization's files need the store this run was not given. */
const filesStoreRequired = (organizationId: string) =>
  `BRAIVO_FILES must be set, as serve has it, to delete the files of personal organization ${organizationId}.`;

/**
 * Empties an erased personal organization's files, after the commit that
 * erased its rows (ADR 0060): a failure leaves bytes nothing names, never a
 * row whose bytes are gone, and the record pending for a second run. Answers
 * whether a store was asked: with none, the caller has established there are
 * none to delete.
 */
async function deleteFiles(files: FileStore | undefined, record: ErasureRecord): Promise<boolean> {
  if (record.scope !== "account" || record.personalOrganizationId === null) return false;
  if (files === undefined) return false;
  try {
    await files.deletePrefix(filesOf(record.personalOrganizationId));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The account was erased, but the files of its personal organization ${record.personalOrganizationId} could not all be deleted: ${why}\nLog record ${record.id} is pending; run this command again to finish it.`,
    );
  }
  return true;
}

/**
 * Erases the account and every row referring to it (access-49), all or nothing,
 * under the locks of every school it reaches, its personal organization with it
 * and that organization's files after commit (ADR 0060). The log's intent comes
 * once nothing can refuse and before anything is deleted, and is marked done
 * after commit and the files' deletion, as `eraseLearnerHistory`'s is.
 *
 * No epoch moves, unlike a school's erasure: its fence cascades away in this
 * commit, so none could be read (ADR 0053).
 */
export async function eraseAccount(input: {
  database: Database;
  target: AccountErasureTarget;
  log: ErasureLog;
  /**
   * The server's file store; required where a personal organization's files
   * may need deleting, as rows cannot say none were stored: an upload that
   * failed after storing its bytes recorded none.
   */
  files: FileStore | undefined;
  /**
   * What `resolvePendingErasures` found first: each record of this same account
   * not found committed is closed as superseded by this one once it commits,
   * the personal organization that record names emptied first.
   */
  resolved?: readonly PendingErasureOutcome[];
}): Promise<{
  recordId: string;
  removed: AccountErasureCounts;
  personal: PersonalOrganizationErasure | null;
  filesDeleted: boolean;
}> {
  const { database, target, log, files, resolved = [] } = input;
  const { userId, email } = target;
  const superseded = resolved
    .filter(({ outcome, record }) => outcome === "not committed" && record.userId === userId)
    .map(({ record }) => record);
  // Before anything: a personal organization's files, this one's or a superseded
  // record's, are the store's to delete. A personal organization made since the
  // preview is refused under the lock.
  const needsFiles = [
    target.personal?.id,
    ...superseded.map((record) => record.personalOrganizationId),
  ].find((organizationId) => organizationId != null);
  if (needsFiles !== undefined && files === undefined) {
    throw new Error(`${filesStoreRequired(needsFiles)} Nothing was erased.`);
  }

  let pending: string | undefined;
  const { record, removed, personal } = await withAccountLock(
    database,
    target,
    async (transaction, locks) => {
      // What recovery's wait on the account's row stands on (`resolvePendingErasures`).
      if (userId !== null && !locks.accountRow) {
        throw new Error("An account's erasure intent must be written while its row is held.");
      }
      const record = await writeErasureIntent(
        log,
        { scope: "account", userId, personalOrganizationId: target.personal?.id ?? null },
        email,
      );
      pending = record.id;
      const { counts, personal } = await deleteAccount(transaction, { userId, email }, record.id);
      return { record, removed: counts, personal };
    },
  ).catch((error: unknown) => {
    if (pending === undefined) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`${why}\nLog record ${pending} is pending, for account ${userId ?? "(none)"}.`);
  });

  const filesDeleted = await deleteFiles(files, record);
  await markErasureDone(log, record);
  for (const earlier of superseded) {
    try {
      // Its own organization may not be this one's, as after a restore from before it.
      await deleteFiles(files, earlier);
      await markErasureSuperseded(log, earlier, record.id);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The account was erased under log record ${record.id}, done, but earlier log record ${earlier.id} could not be closed: ${why}\nIt stays pending, for the replay; note both IDs in the request's register entry.`,
      );
    }
  }
  return { recordId: record.id, removed, personal, filesDeleted };
}

/** What became of an account erasure left pending, found again by its email. */
export type PendingErasureOutcome = {
  record: AccountErasureRecord;
  /**
   * `done`, committed and now finished; `not committed`, its account's row free
   * and no marker, so rolled back or lost to a restore, left pending until a
   * later erasure of that account commits (`eraseAccount`'s `resolved`);
   * `held`, its account's row still held past the wait, left as it was;
   * `undetermined`, no account to wait on and no marker, so possibly still
   * running, left pending for ADR 0053's replay.
   */
  outcome: "done" | "not committed" | "held" | "undetermined";
  /** Whether a store was asked to empty its personal organization's files. */
  filesDeleted: boolean;
};

/**
 * Resolves `email`'s account erasures left pending, before that email's account
 * is considered afresh (ADR 0060), each bound to its record's own IDs, never
 * the email's account now, which may be a later registration. A record with an
 * account is judged once no transaction holds that account's row, waiting
 * `timeoutMs` at most: committed, its personal organization's files are emptied
 * and it is done; otherwise it is reported, and closed only by a later erasure
 * of that account (`eraseAccount`), since a restored database lacks a marker
 * that did commit. One with no account, whose transaction locks no row, is done
 * if its marker is there, and otherwise left pending, as a missing marker
 * cannot tell a rollback from one still running. Changes nothing for a
 * committed record naming a personal organization without the store its files
 * need: that record stays pending, and this throws saying so.
 */
export async function resolvePendingErasures(input: {
  database: Database;
  log: ReadableErasureLog;
  files: FileStore | undefined;
  email: string;
  timeoutMs: number;
}): Promise<PendingErasureOutcome[]> {
  const { database, log, files, timeoutMs } = input;
  const email = normalized(input.email);
  const outcomes: PendingErasureOutcome[] = [];
  for (const record of await readPendingAccountErasures(log, email)) {
    const { id: recordId, userId, personalOrganizationId } = record;
    const committed = await readAccountErasureCommitted(database, {
      erasureId: recordId,
      userId,
      timeoutMs,
    });
    let outcome: PendingErasureOutcome["outcome"];
    let filesDeleted = false;
    if (committed === "held") outcome = "held";
    else if (committed) {
      // Its rows are gone, so nothing says whether it had files: only a store can finish it.
      if (personalOrganizationId !== null && files === undefined) {
        throw new Error(
          `${filesStoreRequired(personalOrganizationId)} Log record ${recordId} is still pending; on an installation that keeps no files, any empty directory will do.`,
        );
      }
      filesDeleted = await deleteFiles(files, record);
      await markErasureDone(log, record);
      outcome = "done";
    } else outcome = userId === null ? "undetermined" : "not committed";
    outcomes.push({ record, outcome, filesDeleted });
  }
  return outcomes;
}
