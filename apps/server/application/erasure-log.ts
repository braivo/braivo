// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";

import * as z from "zod";

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
  /** 2 adds `personalOrganizationId` and `supersededBy`; 1 is read as both null. */
  version: 2;
  id: string;
  email: { hmac: string; rule: typeof EMAIL_RULE };
  intentAt: string;
  /** `null` while pending: written before deleting, set after commit. */
  doneAt: string | null;
  /**
   * Set instead of `doneAt` once a later erasure of the same account, under
   * this record's ID, committed (ADR 0060): this one's transaction was not
   * found committed, and the later record carries out what it asked.
   */
  supersededBy: string | null;
};

/** One school's history of one learner. */
export type OrganizationErasure = {
  scope: "organization";
  userId: string;
  organizationId: string;
  epoch: number;
  endMembership: boolean;
};

/**
 * A whole account; `userId` null when only rows naming the address go. With
 * it, the account's personal organization, whose file bytes go after commit
 * (ADR 0060).
 */
type AccountErasure = {
  scope: "account";
  userId: string | null;
  personalOrganizationId: string | null;
};

type ErasureSubject = OrganizationErasure | AccountErasure;

/** An account's erasure, as its log record says. */
export type AccountErasureRecord = ErasureRecord<AccountErasure>;

/** Where the log's records go, and the key its HMAC is under. */
export type ErasureLog = {
  store: Pick<FileStore, "put">;
  hmacKey: string;
};

/** The log read back too, to find erasures left pending (ADR 0060). */
export type ReadableErasureLog = ErasureLog & { store: Pick<FileStore, "put" | "get" | "list"> };

function writeRecord(log: ErasureLog, record: ErasureRecord): Promise<void> {
  return log.store.put(
    `${record.id}.json`,
    new TextEncoder().encode(`${JSON.stringify(record)}\n`),
    "application/json",
  );
}

/** The email's HMAC as records hold it: `email` normalized as sign-in stores it. */
function emailHmac(log: Pick<ErasureLog, "hmacKey">, email: string): string {
  return createHmac("sha256", log.hmacKey).update(email).digest("hex");
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
    version: 2,
    id: crypto.randomUUID(),
    email: { hmac: emailHmac(log, email), rule: EMAIL_RULE },
    intentAt: new Date().toISOString(),
    doneAt: null,
    supersededBy: null,
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

/**
 * Closes a record whose transaction was not found committed, once `by`, a
 * later erasure of the same account, committed. Never before: after a restore
 * a missing marker cannot prove a rollback, so until then the record keeps its
 * instruction for the replay.
 */
export async function markErasureSuperseded(
  log: ErasureLog,
  record: ErasureRecord,
  by: string,
): Promise<void> {
  await writeRecord(log, { ...record, supersededBy: by });
}

const timestamp = z.iso.datetime();
const common = {
  format: z.literal("braivo-erasure-log"),
  id: z.uuid(),
  email: z.strictObject({ hmac: z.string().regex(/^[0-9a-f]{64}$/), rule: z.literal(EMAIL_RULE) }),
  intentAt: timestamp,
  doneAt: timestamp.nullable(),
};
const organizationScope = {
  scope: z.literal("organization"),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  epoch: z.int().nonnegative(),
  endMembership: z.boolean(),
};
const accountScope = { scope: z.literal("account"), userId: z.string().min(1).nullable() };
const supersededBy = z.uuid().nullable();
const personalOrganizationId = z.string().min(1).nullable();
/** Every version this code wrote, the older read as the newer. */
const RECORD = z.union([
  z.strictObject({ ...common, ...organizationScope, version: z.literal(2), supersededBy }),
  z.strictObject({
    ...common,
    ...accountScope,
    version: z.literal(2),
    supersededBy,
    personalOrganizationId,
  }),
  z
    .strictObject({ ...common, ...organizationScope, version: z.literal(1) })
    .transform((record) => ({ ...record, version: 2 as const, supersededBy: null })),
  z.strictObject({ ...common, ...accountScope, version: z.literal(1) }).transform((record) => ({
    ...record,
    version: 2 as const,
    supersededBy: null,
    personalOrganizationId: null,
  })),
]);

/**
 * The account-scope records of `email` still pending, neither done nor
 * closed, by their intent's time: what running that email's erasure again
 * resolves first (ADR 0060). Fails closed, naming it, on a record it cannot
 * read: a record skipped could be an erasure left unfinished.
 */
export async function readPendingAccountErasures(
  log: ReadableErasureLog,
  email: string,
): Promise<AccountErasureRecord[]> {
  const hmac = emailHmac(log, email);
  const pending: AccountErasureRecord[] = [];
  for (const key of await log.store.list("")) {
    const blob = await log.store.get(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse((await blob?.text()) ?? "");
    } catch {
      parsed = undefined;
    }
    const read = RECORD.safeParse(parsed);
    if (!read.success || key !== `${read.data.id}.json`) {
      throw new Error(
        `The erasure log's ${key} is not a record this command can read. Nothing was changed; check it before running this again.`,
      );
    }
    const record = read.data as ErasureRecord;
    if (record.scope !== "account" || record.email.hmac !== hmac) continue;
    if (record.doneAt === null && record.supersededBy === null) pending.push(record);
  }
  return pending.toSorted((a, b) => a.intentAt.localeCompare(b.intentAt));
}
