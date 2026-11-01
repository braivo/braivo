// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import {
  account,
  attempt,
  group,
  groupMember,
  learnerEvidence,
  learnerSession,
  member,
  oauthClient,
  oauthConsent,
  objective,
  organization,
  session,
  task,
  taskReport,
  user,
} from "@braivo/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { StoredTaskReport } from "./task-report.ts";
import type { Transaction } from "./task.ts";

/**
 * What a learner export reads, row by row, before `exportLearner` shapes it
 * (docs/adr/0053-learners-data.md). Every select names its columns: a column
 * added to a table later stays out until someone adds it here, so the export
 * fails closed rather than leaking a new secret.
 */
export type LearnerExportRows = {
  user: { name: string; email: string; createdAt: Date };
  /** In scope and holding the learner's membership or history, by name. */
  organizations: { id: string; name: string }[];
  memberships: { organizationId: string; role: string; createdAt: Date }[];
  groups: { organizationId: string; name: string; role: "learner" | "teacher" }[];
  attempts: {
    organizationId: string;
    at: Date;
    body: unknown;
    response: unknown;
    outcome: "success" | "failure" | null;
    taskRetiredAt: Date | null;
    /** The learner's report of it, if any (ADR 0052), whatever became of it. */
    report: (StoredTaskReport & { dismissedAt: Date | null }) | null;
  }[];
  evidence: {
    organizationId: string;
    id: string;
    at: Date;
    objective: string;
    outcome: "success" | "failure";
  }[];
  /** The account layer, read only for the account's scope. */
  account?: {
    providers: string[];
    connectedApps: {
      name: string | null;
      scopes: string[];
      createdAt: Date | null;
      updatedAt: Date | null;
    }[];
    consoleSessions: { createdAt: Date; expiresAt: Date }[];
    learnSessions: { organization: string; hostname: string; expiresAt: Date }[];
  };
};

/**
 * Reads one learner's data in one snapshot, read-only, so the database refuses
 * any write and every part agrees with every other. `organizationId` limits it
 * to that organization and skips the account layer; absent, it is the account's.
 * `undefined` when no account has `email`, already normalized by the caller.
 */
export async function readLearnerExport(
  database: Database,
  input: { email: string; organizationId?: string },
): Promise<LearnerExportRows | undefined> {
  return database.transaction(
    async (transaction) => {
      const [person] = await transaction
        .select({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt })
        .from(user)
        .where(eq(user.email, input.email));
      if (person === undefined) return undefined;
      const learnerId = person.id;
      const scoped = input.organizationId;

      // Where the learner has membership or history, which is where they have records.
      const held = await transaction.execute<{ id: string }>(sql`
        select ${member.organizationId} as id from ${member} where ${member.userId} = ${learnerId}
        union select ${attempt.organizationId} from ${attempt} where ${attempt.learnerId} = ${learnerId}
        union select ${learnerEvidence.organizationId} from ${learnerEvidence} where ${learnerEvidence.learnerId} = ${learnerId}
      `);
      const ids = held.rows
        .map((row) => row.id)
        .filter((id) => scoped === undefined || id === scoped);
      const { id: _, ...shown } = person;

      const organizations = await transaction
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(inArray(organization.id, ids))
        .orderBy(asc(organization.name), asc(organization.id));

      const memberships = await transaction
        .select({
          organizationId: member.organizationId,
          role: member.role,
          createdAt: member.createdAt,
        })
        .from(member)
        .where(and(eq(member.userId, learnerId), inArray(member.organizationId, ids)));

      const groups = await transaction
        .select({
          organizationId: groupMember.organizationId,
          name: group.name,
          role: groupMember.role,
        })
        .from(groupMember)
        .innerJoin(group, eq(group.id, groupMember.groupId))
        .where(and(eq(groupMember.userId, learnerId), inArray(groupMember.organizationId, ids)))
        .orderBy(asc(group.name), asc(group.id));

      // An attempt's grade is the evidence recorded with it, under the ID
      // `submitAttempt` gives it (`ATTEMPT_EVIDENCE_PREFIX`, `activity.ts`).
      const attempts = await transaction
        .select({
          organizationId: attempt.organizationId,
          at: attempt.at,
          body: task.body,
          response: attempt.response,
          outcome: learnerEvidence.outcome,
          taskRetiredAt: task.retiredAt,
          // All the report's own columns, so Drizzle reads no report as `null`.
          report: {
            reason: taskReport.reason,
            note: taskReport.note,
            at: taskReport.createdAt,
            dismissedAt: taskReport.dismissedAt,
          },
        })
        .from(attempt)
        .innerJoin(
          task,
          and(eq(task.organizationId, attempt.organizationId), eq(task.id, attempt.taskId)),
        )
        .leftJoin(
          learnerEvidence,
          and(
            eq(learnerEvidence.learnerId, attempt.learnerId),
            eq(learnerEvidence.organizationId, attempt.organizationId),
            eq(learnerEvidence.id, sql`'attempt:' || ${attempt.id} || ':' || ${task.objectiveId}`),
          ),
        )
        .leftJoin(
          taskReport,
          and(
            eq(taskReport.learnerId, attempt.learnerId),
            eq(taskReport.organizationId, attempt.organizationId),
            eq(taskReport.attemptId, attempt.id),
          ),
        )
        .where(and(eq(attempt.learnerId, learnerId), inArray(attempt.organizationId, ids)))
        .orderBy(asc(attempt.at), asc(attempt.id));

      const evidence = await transaction
        .select({
          organizationId: learnerEvidence.organizationId,
          id: learnerEvidence.id,
          at: learnerEvidence.at,
          objective: objective.title,
          outcome: learnerEvidence.outcome,
        })
        .from(learnerEvidence)
        .innerJoin(
          objective,
          and(
            eq(objective.organizationId, learnerEvidence.organizationId),
            eq(objective.id, learnerEvidence.objectiveId),
          ),
        )
        .where(
          and(
            eq(learnerEvidence.learnerId, learnerId),
            inArray(learnerEvidence.organizationId, ids),
          ),
        )
        .orderBy(asc(learnerEvidence.at), asc(learnerEvidence.id));

      return {
        user: shown,
        organizations,
        memberships,
        groups,
        attempts,
        evidence,
        account: scoped === undefined ? await readAccount(transaction, learnerId) : undefined,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function readAccount(
  transaction: Transaction,
  learnerId: string,
): Promise<NonNullable<LearnerExportRows["account"]>> {
  const providers = await transaction
    .selectDistinct({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, learnerId))
    .orderBy(asc(account.providerId));
  const connectedApps = await transaction
    .select({
      name: oauthClient.name,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      updatedAt: oauthConsent.updatedAt,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, learnerId))
    .orderBy(asc(oauthConsent.createdAt), asc(oauthConsent.id));
  const consoleSessions = await transaction
    .select({ createdAt: session.createdAt, expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.userId, learnerId))
    .orderBy(asc(session.createdAt), asc(session.id));
  const learnSessions = await transaction
    .select({
      organization: organization.name,
      hostname: learnerSession.hostname,
      expiresAt: learnerSession.expiresAt,
    })
    .from(learnerSession)
    .innerJoin(organization, eq(organization.id, learnerSession.organizationId))
    .where(eq(learnerSession.userId, learnerId))
    .orderBy(asc(learnerSession.expiresAt), asc(learnerSession.tokenHash));
  return {
    providers: providers.map((row) => row.providerId),
    connectedApps,
    consoleSessions,
    learnSessions,
  };
}
