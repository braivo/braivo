// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";

import type { FileStore } from "../storage/index.ts";

/** How `email.hmac` was normalized, so a later rule can tell its own records apart. */
const EMAIL_RULE = "trim-lowercase-v1";

/**
 * A record of the replay log, one per erasure, kept outside the database and its
 * backups so a restore can carry the erasure out again
 * (docs/adr/0053-learners-data.md). `endMembership` as replay cannot read that
 * choice from a restored database. The email only as an HMAC under a key kept
 * outside them too, for rows that name no user.
 */
export type ErasureRecord<Subject extends ErasureSubject = ErasureSubject> = Subject & {
  format: "braivo-erasure-log";
  version: 1;
  id: string;
  email: { hmac: string; rule: typeof EMAIL_RULE };
  intentAt: string;
  /** `null` while pending: written before deleting, set after commit. */
  doneAt: string | null;
};

/** One school's history of one learner. */
export type OrganizationErasure = {
  scope: "organization";
  userId: string;
  organizationId: string;
  epoch: number;
  endMembership: boolean;
};

/** A whole account; `userId` null when only rows naming the address go. */
type AccountErasure = { scope: "account"; userId: string | null };

type ErasureSubject = OrganizationErasure | AccountErasure;

/** Where the log's records go, and the key its HMAC is under. */
export type ErasureLog = {
  store: Pick<FileStore, "put">;
  hmacKey: string;
};

function writeRecord(log: ErasureLog, record: ErasureRecord): Promise<void> {
  return log.store.put(
    `${record.id}.json`,
    new TextEncoder().encode(`${JSON.stringify(record)}\n`),
    "application/json",
  );
}

/** Records that an erasure is about to run: `email` normalized as sign-in stores it. */
export async function writeErasureIntent<Subject extends ErasureSubject>(
  log: ErasureLog,
  subject: Subject,
  email: string,
): Promise<ErasureRecord<Subject>> {
  const record: ErasureRecord<Subject> = {
    ...subject,
    format: "braivo-erasure-log",
    version: 1,
    id: crypto.randomUUID(),
    email: {
      hmac: createHmac("sha256", log.hmacKey).update(email).digest("hex"),
      rule: EMAIL_RULE,
    },
    intentAt: new Date().toISOString(),
    doneAt: null,
  };
  await writeRecord(log, record);
  return record;
}

/**
 * Called after commit. A failure says so rather than done, and is not one to
 * repeat blindly: what it erased is gone, and a replay would carry the pending
 * record out again, harmlessly.
 */
export async function markErasureDone(log: ErasureLog, record: ErasureRecord): Promise<void> {
  try {
    await writeRecord(log, { ...record, doneAt: new Date().toISOString() });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The ${record.scope === "account" ? "account" : "history"} was erased, but log record ${record.id} could not be marked done: ${why}`,
    );
  }
}
