// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import type { Evidence } from "../learning/index.ts";
import {
  findObjectivesOutsideOrganization,
  readOrganizationRoles,
  recordEvidence,
} from "../persistence/index.ts";
import { ATTEMPT_EVIDENCE_PREFIX } from "./activity.ts";
import { assertMayAdminister, NotPermitted } from "./permission.ts";

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
 * Records graded evidence for a learner, on behalf of one organization.
 *
 * Checks run in this order, and any failure refuses the whole batch:
 *
 * 1. Every date is valid and not ahead of `now`, and no ID is in the namespace
 *    attempts are graded into. This reads only the payload, so
 *    a caller who may not grade learns nothing about the organization.
 * 2. `gradedBy` administers the organization. Without this, a learner could
 *    award themselves successes.
 * 3. The learner is a member.
 * 4. Every objective is the organization's own.
 *
 * Checks 3 and 4 are the only guard on "a learner and their objectives belong to
 * one organization": evidence carries no organization, since membership changes
 * and evidence must outlive it.
 *
 * Membership holds as of the check. A learner removed before the insert still
 * gets the batch, but the row is inert: this organization's decisions re-check
 * membership, and no other organization's course has the objective. Locking
 * `member` to close the window would stall every membership change for nothing.
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
  /** When the evidence was received, which is what its dates are held to. */
  now: Date;
}): Promise<void> {
  const { database, organizationId, gradedBy, learnerId, evidence, now } = input;
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

  const learnerRoles = await readOrganizationRoles(database, { organizationId, userId: learnerId });
  if (learnerRoles.length === 0) {
    throw new NotPermitted(
      `Learner "${learnerId}" is not a member of organization "${organizationId}".`,
    );
  }

  const outside = await findObjectivesOutsideOrganization(
    database,
    organizationId,
    evidence.map((record) => record.objectiveId),
  );
  if (outside.length > 0) {
    throw new NotPermitted(
      `Organization "${organizationId}" does not own ${outside.map((id) => `"${id}"`).join(", ")}.`,
    );
  }

  await recordEvidence(database, learnerId, evidence);
}
