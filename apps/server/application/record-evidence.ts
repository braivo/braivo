// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { Evidence } from "../learning/index.ts";
import {
  findObjectivesOutsideOrganization,
  HistoryErased,
  withLearnerHistoryLock,
  recordEvidence,
} from "../persistence/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
import { assertMayAdminister, isMember, NotPermitted } from "./permission.ts";

/**
 * Evidence that cannot be recorded as sent, whoever sent it: a date that is not
 * one, or one after the evidence arrived. `NotPermitted` is about who is asking
 * and what they named; this is about the payload itself.
 */
export class InvalidEvidence extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvidence";
  }
}

/**
 * How far past its arrival a grading result may be dated.
 *
 * A record dated ahead is a grader bug (milliseconds taken for seconds, local
 * time written as UTC), and once stored it cannot be fixed: reads skip it until
 * its date comes, and a corrected resend is refused as a conflict. So it is
 * refused on the way in.
 *
 * Five minutes covers clocks that disagree and is shorter than any time-zone
 * offset, so a zone mistake is still caught. Past dates are unbounded: importing
 * an old history is legitimate, and an old date alone proves nothing.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Room for a UUID or a composite integration key. Unbounded, a long ID would
 * overflow PostgreSQL's index entry limit as an error rather than a refusal.
 */
export const MAX_EVIDENCE_ID_LENGTH = 256;

/**
 * Records graded evidence for a learner, on behalf of one organization.
 *
 * Checks run in this order, and any failure refuses the whole batch:
 *
 * 1. Every date is valid and not ahead of `now`, and every ID is at most
 *    `MAX_EVIDENCE_ID_LENGTH` and outside the namespace attempts are graded
 *    into. This reads only the payload, so a caller who may not grade learns
 *    nothing about the organization.
 * 2. `gradedBy` administers the organization. Without this, a learner could
 *    award themselves successes.
 * 3. The learner is a member.
 * 4. Every objective is the organization's own.
 *
 * Check 3 is the only guard on "a learner belongs to the organization grading
 * them": evidence carries the organization that recorded it, not membership,
 * which changes while evidence must outlive it. Check 4 answers before the
 * schema would, which refuses evidence about another organization's objective.
 *
 * 5. The learner's history here was not erased since the batch was begun: with
 *    a `historyEpoch`, it is the current one; without one, every record is dated
 *    past the erasure by more than `MAX_CLOCK_SKEW_MS`, so a record that could
 *    have been stored ahead of it, then erased and replayed, cannot return
 *    (docs/adr/0053-learners-data.md).
 *
 * Checks 3 to 5 and the write run under the lock an erasure takes, so a batch
 * lands wholly before one, and is erased, or after it, and is refused.
 *
 * An empty batch does nothing and checks nothing.
 */
export async function recordGradedEvidence(input: {
  database: Database;
  organizationId: string;
  /** The signed-in actor claiming to have graded this, who must administer the organization. */
  gradedBy: string;
  learnerId: string;
  evidence: readonly Evidence[];
  /** The history epoch the sender read (`readLearnerProgress`), if it did. */
  historyEpoch?: number;
  /** When the evidence was received, which is what its dates are held to. */
  now: Date;
}): Promise<void> {
  const { database, organizationId, gradedBy, learnerId, evidence, historyEpoch, now } = input;
  if (evidence.length === 0) return;

  // `Invalid Date` compares false against everything, so an unchecked one would
  // let every record through rather than stop any.
  const received = now.getTime();
  if (Number.isNaN(received)) throw new RangeError("The `now` argument is not a valid date.");

  const undated = evidence.filter((record) => Number.isNaN(record.at.getTime()));
  if (undated.length > 0) {
    throw new InvalidEvidence(
      `Evidence ${undated.map((record) => `"${record.id}"`).join(", ")} has no valid date.`,
    );
  }

  // Counted rather than quoted: the IDs are the problem.
  const oversized = evidence.filter((record) => record.id.length > MAX_EVIDENCE_ID_LENGTH);
  if (oversized.length > 0) {
    throw new InvalidEvidence(
      `An evidence ID may be at most ${MAX_EVIDENCE_ID_LENGTH} characters; this batch has ${oversized.length} longer.`,
    );
  }

  const reserved = evidence.filter((record) => record.id.startsWith(ATTEMPT_EVIDENCE_PREFIX));
  if (reserved.length > 0) {
    throw new InvalidEvidence(
      `Evidence ${reserved.map((record) => `"${record.id}"`).join(", ")} uses the reserved prefix "${ATTEMPT_EVIDENCE_PREFIX}".`,
    );
  }

  const ahead = evidence.filter((record) => record.at.getTime() > received + MAX_CLOCK_SKEW_MS);
  if (ahead.length > 0) {
    throw new InvalidEvidence(
      `Evidence ${ahead.map((record) => `"${record.id}"`).join(", ")} is dated after ${now.toISOString()}, when it was received.`,
    );
  }

  await assertMayAdminister(database, { organizationId, userId: gradedBy });

  const scope = { learnerId, organizationId };
  await withLearnerHistoryLock(database, scope, async (transaction, history) => {
    if (!(await isMember(transaction, { organizationId, userId: learnerId }))) {
      throw new NotPermitted(
        `Learner "${learnerId}" is not a member of organization "${organizationId}".`,
      );
    }

    const outside = await findObjectivesOutsideOrganization(
      transaction,
      organizationId,
      evidence.map((record) => record.objectiveId),
    );
    if (outside.length > 0) {
      throw new NotPermitted(
        `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
      );
    }

    if (
      historyEpoch === undefined
        ? mayPredateErasure(evidence, history.erasedAt)
        : historyEpoch !== history.epoch
    ) {
      throw new HistoryErased();
    }

    await recordEvidence(transaction, scope, evidence);
  });
}

/**
 * Whether a batch naming no epoch holds a record that could be from before the
 * erasure. Inclusive, as `MAX_CLOCK_SKEW_MS` is: one dated exactly that far past
 * it may have been recorded in the erasure's last moment.
 */
function mayPredateErasure(evidence: readonly Evidence[], erasedAt: Date | null): boolean {
  if (erasedAt === null) return false;
  const limit = erasedAt.getTime() + MAX_CLOCK_SKEW_MS;
  return evidence.some((record) => record.at.getTime() <= limit);
}
