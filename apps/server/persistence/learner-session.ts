// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import {
  learnerHandoff,
  learnerSession,
  organization,
  organizationDomain,
  user,
} from "@braivo/db/schema";
import { and, eq, gt, lte, sql } from "drizzle-orm";

/**
 * A handoff whose domain still serves its organization: one moved since to
 * another organization, or removed, hands nothing over.
 */
const handoffDomainHolds = sql`exists (
  select 1 from ${organizationDomain}
  where ${organizationDomain.hostname} = ${learnerHandoff.hostname}
    and ${organizationDomain.organizationId} = ${learnerHandoff.organizationId}
)`;

/**
 * Records a handoff, and forgets every one already expired: they are only
 * ever looked up while live, and nothing else would remove them.
 */
export async function insertHandoff(
  database: Database,
  input: {
    id: string;
    organizationId: string;
    hostname: string;
    returnPath: string;
    nonceHash: string;
    expiresAt: Date;
    at: Date;
  },
): Promise<void> {
  const { at, ...handoff } = input;
  await database.delete(learnerHandoff).where(lte(learnerHandoff.expiresAt, at));
  await database.insert(learnerHandoff).values(handoff);
}

/** A live handoff's organization and the hostname it returns to. */
export async function readHandoff(
  database: Database,
  input: { id: string; at: Date },
): Promise<{ organization: { id: string; name: string }; hostname: string } | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name, hostname: learnerHandoff.hostname })
    .from(learnerHandoff)
    .innerJoin(organization, eq(organization.id, learnerHandoff.organizationId))
    .where(
      and(
        eq(learnerHandoff.id, input.id),
        gt(learnerHandoff.expiresAt, input.at),
        handoffDomainHolds,
      ),
    );
  return row && { organization: { id: row.id, name: row.name }, hostname: row.hostname };
}

/**
 * Completes a live handoff for `userId` with a code good until `expiresAt`,
 * replacing any code issued before, but never past the handoff's own expiry:
 * the nonce cookie the browser holds ends then. Answers whether it was live.
 */
export async function issueHandoffCode(
  database: Database,
  input: { id: string; userId: string; codeHash: string; expiresAt: Date; at: Date },
): Promise<boolean> {
  const issued = await database
    .update(learnerHandoff)
    .set({
      userId: input.userId,
      codeHash: input.codeHash,
      expiresAt: sql`least(${learnerHandoff.expiresAt}, ${input.expiresAt})`,
    })
    .where(
      and(
        eq(learnerHandoff.id, input.id),
        gt(learnerHandoff.expiresAt, input.at),
        handoffDomainHolds,
      ),
    )
    .returning({ id: learnerHandoff.id });
  return issued.length > 0;
}

/**
 * Spends a handoff's code and opens the learner session it hands over, in one
 * transaction. Only together with the nonce of the browser that started it, on
 * the hostname it started on, before it expires, and while that hostname still
 * serves its organization: a request missing any of them spends nothing.
 * Forgets every learner session already expired, as `insertHandoff` does
 * handoffs.
 */
export async function spendHandoffCode(
  database: Database,
  input: {
    codeHash: string;
    nonceHash: string;
    hostname: string;
    at: Date;
    session: { tokenHash: string; expiresAt: Date };
  },
): Promise<{ returnPath: string } | undefined> {
  return database.transaction(async (transaction) => {
    const [spent] = await transaction
      .delete(learnerHandoff)
      .where(
        and(
          eq(learnerHandoff.codeHash, input.codeHash),
          eq(learnerHandoff.nonceHash, input.nonceHash),
          eq(learnerHandoff.hostname, input.hostname),
          gt(learnerHandoff.expiresAt, input.at),
          handoffDomainHolds,
        ),
      )
      .returning();
    // Set with the code, so any match has one; checked for the type.
    if (!spent?.userId) return undefined;

    await transaction.delete(learnerSession).where(lte(learnerSession.expiresAt, input.at));
    await transaction.insert(learnerSession).values({
      ...input.session,
      userId: spent.userId,
      organizationId: spent.organizationId,
    });
    return { returnPath: spent.returnPath };
  });
}

/**
 * The user of a live learner session, read on `hostname`: only while that
 * hostname serves the session's organization.
 */
export async function readLearnerSession(
  database: Database,
  input: { tokenHash: string; hostname: string; at: Date },
): Promise<{ user: { id: string; name: string }; expiresAt: Date } | undefined> {
  const [row] = await database
    .select({ id: user.id, name: user.name, expiresAt: learnerSession.expiresAt })
    .from(learnerSession)
    .innerJoin(user, eq(user.id, learnerSession.userId))
    .innerJoin(
      organizationDomain,
      and(
        eq(organizationDomain.organizationId, learnerSession.organizationId),
        eq(organizationDomain.hostname, input.hostname),
      ),
    )
    .where(
      and(eq(learnerSession.tokenHash, input.tokenHash), gt(learnerSession.expiresAt, input.at)),
    );
  return row && { user: { id: row.id, name: row.name }, expiresAt: row.expiresAt };
}

export async function renewLearnerSession(
  database: Database,
  input: { tokenHash: string; expiresAt: Date },
): Promise<void> {
  await database
    .update(learnerSession)
    .set({ expiresAt: input.expiresAt })
    .where(eq(learnerSession.tokenHash, input.tokenHash));
}

export async function deleteLearnerSession(database: Database, tokenHash: string): Promise<void> {
  await database.delete(learnerSession).where(eq(learnerSession.tokenHash, tokenHash));
}
