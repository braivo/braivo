// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type AccountErasureCounts,
  type AffectedOrganization,
  deleteAccount,
  readAccountErasurePreview,
  readUserIdByEmail,
  withAccountLock,
} from "../persistence/index.ts";
import { type ErasureLog, markErasureDone, writeErasureIntent } from "./erasure-log.ts";

export type { AccountErasureCounts, AffectedOrganization };

export type AccountErasureTarget = {
  /** Null when no account has the email, though rows may name it. */
  userId: string | null;
  email: string;
  organizations: AffectedOrganization[];
};

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
  // As sign-in stores it (access-1): Better Auth lowercases, after trimming here.
  const email = input.email.trim().toLowerCase();
  // A blank would match every row with an empty value, and an ended input as typed back.
  if (email === "") throw new Error("An email address is required.");
  const userId = (await readUserIdByEmail(database, email)) ?? null;
  const { organizations, counts } = await readAccountErasurePreview(database, { userId, email });
  return { target: { userId, email, organizations }, counts };
}

/**
 * Erases the account and every row referring to it (access-49), all or nothing,
 * under the locks of every school it reaches. The log's intent comes once nothing can
 * refuse and before anything is deleted, and is marked done after commit, as
 * `eraseLearnerHistory`'s is.
 *
 * No epoch moves, unlike a school's erasure: its fence cascades away in this
 * commit, so none could be read (ADR 0053).
 */
export async function eraseAccount(input: {
  database: Database;
  target: AccountErasureTarget;
  log: ErasureLog;
}): Promise<{ recordId: string; removed: AccountErasureCounts }> {
  const { database, target, log } = input;
  const { userId, email } = target;

  let pending: string | undefined;
  const { record, removed } = await withAccountLock(database, target, async (transaction) => {
    const record = await writeErasureIntent(log, { scope: "account", userId }, email);
    pending = record.id;
    return { record, removed: await deleteAccount(transaction, { userId, email }, record.id) };
  }).catch((error: unknown) => {
    if (pending === undefined) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`${why}\nLog record ${pending} is pending, for account ${userId ?? "(none)"}.`);
  });

  await markErasureDone(log, record);
  return { recordId: record.id, removed };
}
