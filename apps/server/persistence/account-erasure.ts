// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import {
  account,
  accountErasure,
  aiRequest,
  attempt,
  course,
  deviceCode,
  file,
  group,
  groupMember,
  invitation,
  invitationMailClaim,
  learnerEvidence,
  learnerHandoff,
  learnerHistoryState,
  learnerSession,
  learnerSignInCode,
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  objective,
  objectiveCitation,
  organization,
  session,
  source,
  task,
  taskCitation,
  taskReport,
  user,
  verification,
} from "@braivo/db/schema";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { lockLearnerHistory } from "./learner-history.ts";
import { isOnlyOwner, readPersonalOrganization } from "./membership.ts";

/** Who an account's erasure is of: `userId` null when only rows name the address. */
export type AccountErasureScope = { userId: string | null; email: string };

/** What an account's erasure removes, by kind of row, and what it leaves with no user. */
export type AccountErasureCounts = {
  attempts: number;
  evidence: number;
  reports: number;
  memberships: number;
  groups: number;
  fences: number;
  learnerSessions: number;
  consoleSessions: number;
  signInMethods: number;
  connections: number;
  connectionTokens: number;
  registeredApps: number;
  deviceCodes: number;
  handoffs: number;
  invitationsSent: number;
  invitationsReceived: number;
  mailClaims: number;
  signInCodes: number;
  verifications: number;
  /** Kept with no user. */
  aiRequests: number;
  reportsDismissed: number;
  settingsChanged: number;
};

/** A school the erasure reaches, for the operator to check it has instructed. */
export type AffectedOrganization = {
  id: string;
  slug: string;
  role: string | null;
  attempts: number;
  evidence: number;
};

/**
 * The account's personal organization, erased with it, and what it holds
 * besides the account's own records, which the account's counts include
 * (ADR 0060). Its file bytes go after commit.
 */
export type PersonalOrganizationErasure = {
  id: string;
  slug: string;
  courses: number;
  objectives: number;
  tasks: number;
  sources: number;
  files: number;
  aiRequests: number;
};

/** The types of Better Auth's email codes, each `<type>-otp-<email>`; `change-email` names the account. */
const EMAIL_CODE_TYPES = ["sign-in", "email-verification", "forget-password"];

/** Whether a string held in a row is this person: exactly, an address in any case. */
function isPerson(text: string, { userId, email }: AccountErasureScope): boolean {
  return text === userId || text.toLowerCase() === email;
}

/**
 * Whether stored text names the person: itself, or a value within it, as JSON
 * (OAuth state's `link`, an authorization code's `userId`) or a URL-encoded query
 * (a client's `login_hint`, which Better Auth keeps encoded in state). Whole
 * values only: a client's opaque `state` that merely contains an ID, or a longer
 * address containing this one, is someone else's. By value rather than path, so a
 * field Better Auth adds later is found too.
 */
function namesPerson(value: unknown, person: AccountErasureScope): boolean {
  if (Array.isArray(value)) return value.some((item) => namesPerson(item, person));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => namesPerson(item, person));
  }
  if (typeof value !== "string") return false;
  if (isPerson(value, person)) return true;
  if (/^[{[]/.test(value)) {
    try {
      return namesPerson(JSON.parse(value), person);
    } catch {
      return false;
    }
  }
  return (
    value.includes("=") &&
    [...new URLSearchParams(value).values()].some((item) => namesPerson(item, person))
  );
}

/**
 * The `verification` rows naming the person, which no foreign key reaches.
 * Decided here rather than in SQL, as they hold JSON and encoded queries that a
 * cast would fail on; reading the whole table suits a rare operator's command.
 * Knows Better Auth's formats: recheck on upgrading it.
 */
async function verificationIdsNaming(
  database: Database | Transaction,
  scope: AccountErasureScope,
): Promise<string[]> {
  const { userId, email } = scope;
  const identifiers = new Set([
    ...EMAIL_CODE_TYPES.map((type) => `${type}-otp-${email}`),
    `sign-in-code-sent:${email}`,
  ]);
  const changeEmail = userId === null ? undefined : `change-email-otp-${userId}:`;
  const rows = await database
    .select({ id: verification.id, identifier: verification.identifier, value: verification.value })
    .from(verification);
  return rows
    .filter(
      ({ identifier, value }) =>
        identifiers.has(identifier) ||
        (changeEmail !== undefined && identifier.startsWith(changeEmail)) ||
        namesPerson(value, scope),
    )
    .map(({ id }) => id);
}

const invitedAddress = sql`lower(${invitation.email})`;

/** How many rows of each kind are there, to confirm and to report. */
async function readCounts(
  database: Database | Transaction,
  scope: AccountErasureScope,
  /** Whose rows go with it, so are not kept with no user. */
  personalId: string | null,
): Promise<AccountErasureCounts> {
  const { userId, email } = scope;
  const outside = <T extends typeof aiRequest.organizationId | typeof organization.id>(column: T) =>
    personalId === null ? undefined : ne(column, personalId);
  const count = async (table: PgTable, where: () => SQL | undefined) =>
    userId === null ? 0 : database.$count(table, where());
  const id = userId ?? "";
  return {
    attempts: await count(attempt, () => eq(attempt.learnerId, id)),
    evidence: await count(learnerEvidence, () => eq(learnerEvidence.learnerId, id)),
    reports: await count(taskReport, () => eq(taskReport.learnerId, id)),
    memberships: await count(member, () => eq(member.userId, id)),
    groups: await count(groupMember, () => eq(groupMember.userId, id)),
    fences: await count(learnerHistoryState, () => eq(learnerHistoryState.learnerId, id)),
    learnerSessions: await count(learnerSession, () => eq(learnerSession.userId, id)),
    consoleSessions: await count(session, () => eq(session.userId, id)),
    signInMethods: await count(account, () => eq(account.userId, id)),
    connections: await count(oauthConsent, () => eq(oauthConsent.userId, id)),
    connectionTokens:
      (await count(oauthAccessToken, () => eq(oauthAccessToken.userId, id))) +
      (await count(oauthRefreshToken, () => eq(oauthRefreshToken.userId, id))),
    registeredApps: await count(oauthClient, () => eq(oauthClient.userId, id)),
    deviceCodes: await count(deviceCode, () => eq(deviceCode.userId, id)),
    handoffs: await count(learnerHandoff, () => eq(learnerHandoff.userId, id)),
    invitationsSent: await count(invitation, () =>
      and(eq(invitation.inviterId, id), ne(invitedAddress, email)),
    ),
    invitationsReceived: await database.$count(invitation, eq(invitedAddress, email)),
    mailClaims: await database.$count(invitationMailClaim, eq(invitationMailClaim.email, email)),
    signInCodes: await database.$count(learnerSignInCode, eq(learnerSignInCode.email, email)),
    verifications: (await verificationIdsNaming(database, scope)).length,
    aiRequests: await count(aiRequest, () =>
      and(eq(aiRequest.userId, id), outside(aiRequest.organizationId)),
    ),
    reportsDismissed: await count(taskReport, () =>
      and(eq(taskReport.dismissedBy, id), ne(taskReport.learnerId, id)),
    ),
    settingsChanged: await count(organization, () =>
      and(eq(organization.toolsReadLearnerDataChangedBy, id), outside(organization.id)),
    ),
  };
}

/**
 * The organizations whose rows this erasure removes or takes the person's name
 * from, each of which must have instructed it (ADR 0053): membership, records, a
 * row naming the address, or what they did there.
 */
async function readAffectedOrganizationIds(
  database: Database | Transaction,
  { userId, email }: AccountErasureScope,
): Promise<string[]> {
  // No account matches nothing: no row has a null ID.
  const { rows } = await database.execute<{ id: string }>(sql`
    select ${member.organizationId} as id from ${member} where ${member.userId} = ${userId}
    union select ${attempt.organizationId} from ${attempt} where ${attempt.learnerId} = ${userId}
    union select ${learnerEvidence.organizationId} from ${learnerEvidence} where ${learnerEvidence.learnerId} = ${userId}
    union select ${learnerHistoryState.organizationId} from ${learnerHistoryState} where ${learnerHistoryState.learnerId} = ${userId}
    union select ${learnerSession.organizationId} from ${learnerSession} where ${learnerSession.userId} = ${userId}
    union select ${learnerHandoff.organizationId} from ${learnerHandoff} where ${learnerHandoff.userId} = ${userId}
    union select ${taskReport.organizationId} from ${taskReport} where ${taskReport.dismissedBy} = ${userId}
    union select ${aiRequest.organizationId} from ${aiRequest} where ${aiRequest.userId} = ${userId}
    union select ${organization.id} from ${organization} where ${organization.toolsReadLearnerDataChangedBy} = ${userId}
    union select ${invitation.organizationId} from ${invitation} where ${invitation.inviterId} = ${userId} or ${invitedAddress} = ${email}
    union select ${invitationMailClaim.organizationId} from ${invitationMailClaim} where ${invitationMailClaim.email} = ${email} and ${invitationMailClaim.organizationId} is not null
    union select ${learnerSignInCode.organizationId} from ${learnerSignInCode} where ${learnerSignInCode.email} = ${email}
  `);
  return rows.map((row) => row.id);
}

/** What a personal organization holds, by kind, to confirm and to report. */
async function readPersonalOrganizationContents(
  database: Database | Transaction,
  userId: string | null,
): Promise<PersonalOrganizationErasure | null> {
  if (userId === null) return null;
  const found = await readPersonalOrganization(database, userId);
  if (!found) return null;
  const inIt = (
    table:
      | typeof course
      | typeof objective
      | typeof task
      | typeof source
      | typeof file
      | typeof aiRequest,
  ) => database.$count(table, eq(table.organizationId, found.id));
  return {
    id: found.id,
    slug: found.slug,
    courses: await inIt(course),
    objectives: await inIt(objective),
    tasks: await inIt(task),
    sources: await inIt(source),
    files: await inIt(file),
    aiRequests: await inIt(aiRequest),
  };
}

/** What the operator is shown before confirming. */
export async function readAccountErasurePreview(
  database: Database,
  scope: AccountErasureScope,
): Promise<{
  organizations: AffectedOrganization[];
  personal: PersonalOrganizationErasure | null;
  counts: AccountErasureCounts;
}> {
  const id = scope.userId ?? "";
  const personal = await readPersonalOrganizationContents(database, scope.userId);
  const counts = await readCounts(database, scope, personal?.id ?? null);
  const ids = await readAffectedOrganizationIds(database, scope);
  const rows = await database
    .select({ id: organization.id, slug: organization.slug, role: member.role })
    .from(organization)
    .leftJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, id)))
    .where(inArray(organization.id, ids))
    .orderBy(asc(organization.slug));
  const organizations = [];
  for (const row of rows) {
    const inIt = (table: typeof attempt | typeof learnerEvidence) =>
      database.$count(table, and(eq(table.learnerId, id), eq(table.organizationId, row.id)));
    organizations.push({
      ...row,
      attempts: await inIt(attempt),
      evidence: await inIt(learnerEvidence),
    });
  }
  return { organizations, personal, counts };
}

/** What the operator confirmed no longer holds: they confirm again, knowing what now holds. */
const changed = (email: string) =>
  new Error(`What holds ${email} changed since it was shown. Nothing was erased; run this again.`);

/** What `withAccountLock` holds once `work` runs: the account's row, when it has one. */
export type AccountLocks = { accountRow: boolean };

/**
 * One transaction holding the account still, or refusing with nothing changed,
 * in this order, which every other writer's fits: the history lock of each school
 * shown, sorted, as no writer holds two; then its sign-in codes and handoffs,
 * which redeeming locks before it references the account; then its personal
 * organization's row, which an upload holds from authorizing to recording
 * (ADR 0060), so one under way finishes first and one arriving later finds
 * nothing; then the account's row, which refuses every new row with a foreign
 * key to it, so what holds the person now stays as read. A school reached, or a
 * personal organization made or gone, since it was shown refuses: no one
 * confirmed it, nor checked it has instructed (ADR 0053). `work` then writes the
 * intent, with nothing left to refuse it, and, for an account, while its row is
 * held: a pending record in the log always belongs to a transaction holding that
 * row until it ends, which recovery relies on (`resolvePendingErasures`).
 */
export async function withAccountLock<T>(
  database: Database,
  target: AccountErasureScope & {
    organizations: readonly { id: string; slug: string }[];
    personal: { id: string } | null;
  },
  work: (transaction: Transaction, locks: AccountLocks) => Promise<T>,
): Promise<T> {
  const { userId, email, organizations, personal } = target;
  const shown = organizations.map(({ id }) => id).toSorted();
  const refuseNewSchools = async (transaction: Transaction) => {
    const affected = await readAffectedOrganizationIds(transaction, target);
    if (affected.some((id) => !shown.includes(id))) throw changed(email);
  };
  return database.transaction(async (transaction) => {
    if (userId === null) {
      const [made] = await transaction
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email));
      if (made !== undefined) throw changed(email);
      await refuseNewSchools(transaction);
      return work(transaction, { accountRow: false });
    }

    for (const organizationId of shown) {
      await lockLearnerHistory(transaction, { learnerId: userId, organizationId });
    }
    await transaction
      .select({ email: learnerSignInCode.email })
      .from(learnerSignInCode)
      .where(eq(learnerSignInCode.email, email))
      .for("update");
    await transaction
      .select({ id: learnerHandoff.id })
      .from(learnerHandoff)
      .where(eq(learnerHandoff.userId, userId))
      .for("update");
    // Before reading what it holds or deleting anything in it.
    const [held] = await transaction
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.personalOwnerId, userId))
      .for("update");
    if (held?.id !== personal?.id) throw changed(email);
    const [row] = await transaction
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (row?.email !== email) throw changed(email);
    // Setup's insert holds this row by reference, so one uncommitted at the
    // check above has committed by now: with the row held, none can follow.
    const made = await readPersonalOrganization(transaction, userId);
    if (made?.id !== personal?.id) throw changed(email);

    await refuseNewSchools(transaction);
    const onlyOwner = [];
    // Sorted, as two owners' erasures lock each other's rows here.
    for (const organizationId of shown) {
      // Their own goes with them (ADR 0060); any other needs another owner.
      if (organizationId === personal?.id) continue;
      if (await isOnlyOwner(transaction, { learnerId: userId, organizationId })) {
        onlyOwner.push(organizations.find(({ id }) => id === organizationId)?.slug);
      }
    }
    if (onlyOwner.length > 0) {
      throw new Error(
        `${email} is the only owner of ${onlyOwner.join(", ")}; give each another owner first, with organization make-owner --slug <slug> --email <successor>. Nothing was erased.`,
      );
    }
    return work(transaction, { accountRow: true });
  });
}

/**
 * Removes the account, in the caller's `withAccountLock`: the rows keyed by its
 * email, which no foreign key reaches, then the row every other cascades or
 * nulls from. `erasureId` marks in the same commit that this one happened. Answers
 * what was there, read under the locks.
 */
export async function deleteAccount(
  transaction: Transaction,
  scope: AccountErasureScope,
  erasureId: string,
): Promise<{ counts: AccountErasureCounts; personal: PersonalOrganizationErasure | null }> {
  const { userId, email } = scope;
  const personal = await readPersonalOrganizationContents(transaction, userId);
  const removed = await readCounts(transaction, scope, personal?.id ?? null);
  const verifications = await verificationIdsNaming(transaction, scope);
  await transaction.delete(verification).where(inArray(verification.id, verifications));
  await transaction.delete(learnerSignInCode).where(eq(learnerSignInCode.email, email));
  await transaction.delete(invitation).where(eq(invitedAddress, email));
  await transaction.delete(invitationMailClaim).where(eq(invitationMailClaim.email, email));
  if (personal) await deleteOrganizationContents(transaction, personal.id);
  if (userId !== null) await transaction.delete(user).where(eq(user.id, userId));
  await transaction.insert(accountErasure).values({ id: erasureId });
  return { counts: removed, personal };
}

/**
 * Everything an organization holds, then the organization: the restricted
 * rows, children before parents, then the row whose deletion cascades the rest
 * (memberships, invitations, domains, sessions, codes, fences, AI usage). Only
 * for a personal organization, which holds its owner's alone (ADR 0060); its
 * file bytes are the caller's, after commit.
 */
async function deleteOrganizationContents(
  transaction: Transaction,
  organizationId: string,
): Promise<void> {
  await transaction
    .delete(objectiveCitation)
    .where(eq(objectiveCitation.organizationId, organizationId));
  await transaction.delete(taskCitation).where(eq(taskCitation.organizationId, organizationId));
  await transaction.delete(taskReport).where(eq(taskReport.organizationId, organizationId));
  await transaction.delete(attempt).where(eq(attempt.organizationId, organizationId));
  await transaction
    .delete(learnerEvidence)
    .where(eq(learnerEvidence.organizationId, organizationId));
  // A task's replacement names it, restricted: unlinked first, so one statement takes them all.
  await transaction
    .update(task)
    .set({ replacesTaskId: null })
    .where(eq(task.organizationId, organizationId));
  await transaction.delete(task).where(eq(task.organizationId, organizationId));
  await transaction.delete(group).where(eq(group.organizationId, organizationId));
  await transaction.delete(course).where(eq(course.organizationId, organizationId));
  await transaction.delete(objective).where(eq(objective.organizationId, organizationId));
  // After the sources that name them as originals.
  await transaction.delete(source).where(eq(source.organizationId, organizationId));
  await transaction.delete(file).where(eq(file.organizationId, organizationId));
  await transaction.delete(organization).where(eq(organization.id, organizationId));
}

/**
 * Whether the account erasure recorded as `erasureId` committed (ADR 0060):
 * its marker in `account_erasure`, which commits with it. With the recorded
 * account's ID, read only once no transaction holds that account's row,
 * waited for at most `timeoutMs`: its intent is written while its erasure holds
 * that row (`withAccountLock`), so an erasure still running finishes first, and
 * a marker absent then means it rolled back. `"held"` when the wait ran out.
 * With none, there is no row to wait on: absent may be still running.
 */
export async function readAccountErasureCommitted(
  database: Database,
  input: { erasureId: string; userId: string | null; timeoutMs: number },
): Promise<boolean | "held"> {
  const { erasureId, userId, timeoutMs } = input;
  const marked = async (reader: Database | Transaction) =>
    (await reader.$count(accountErasure, eq(accountErasure.id, erasureId))) > 0;
  if (userId === null) return marked(database);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("A positive wait is required.");
  return database
    .transaction(async (transaction) => {
      await transaction.execute(sql.raw(`set local lock_timeout = ${timeoutMs}`));
      await transaction.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
      // A statement of its own, so it sees what committed while this one waited.
      return marked(transaction);
    })
    .catch((error: unknown) => {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === "55P03") return "held" as const;
      throw error;
    });
}
