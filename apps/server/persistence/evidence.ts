// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { learnerEvidence } from "@braivo/db/schema";
import { and, asc, eq, inArray, lte } from "drizzle-orm";

import type { Evidence } from "../learning/index.ts";

/**
 * A delivery that disagrees with what is already recorded under its ID.
 *
 * An evidence ID has to identify one attempt. A grader that builds it from the
 * task and the objective instead sends the same ID for every attempt, and
 * before this was detected each attempt after the first was dropped as though
 * it were a retry: a learner who failed once and then succeeded stayed failed,
 * with nothing on either side to say why.
 */
export class ConflictingEvidence extends Error {
  constructor(readonly ids: readonly string[]) {
    super(
      `Evidence ${ids.map((id) => `"${id}"`).join(", ")} is already recorded with a different result. An evidence ID must identify one attempt, not a task.`,
    );
    this.name = "ConflictingEvidence";
  }
}

/**
 * Appends graded evidence for one learner.
 *
 * Redelivering a result is a no-op, because the grader's own ID is the primary
 * key: a retry after a timeout stores nothing twice. A delivery that disagrees
 * with what an ID already holds is refused instead, as `ConflictingEvidence`,
 * and nothing in its batch is stored. The insert alone cannot tell those two
 * apart — it skips both the same way — so the stored rows are compared against
 * the sent ones after it.
 *
 * Deliberately not an upsert. Two different results under one ID is a bug at
 * the grader, and overwriting would hide it while rewriting history that
 * estimates have already been derived from — evidence is the source of truth
 * precisely because it does not change after the fact.
 *
 * The comparison runs after the insert and inside its transaction, not before
 * it. Checked first, a concurrent writer could store a different result in
 * between and this insert would skip it unseen; read afterwards, what comes back
 * is whichever write actually won. Every sent record is compared, not only the
 * ones the insert skipped, because a batch naming one ID twice inserts the first
 * copy and would otherwise never look at the second.
 */
export async function recordEvidence(
  database: Database,
  learnerId: string,
  evidence: readonly Evidence[],
): Promise<void> {
  if (evidence.length === 0) return;

  // Inserted in one fixed order, whatever order they arrived in. Each row takes
  // a lock on its key as it goes in and keeps it until commit, so two writers
  // sending overlapping IDs in different orders could each end up waiting on a
  // row the other holds — a deadlock PostgreSQL resolves by failing one of
  // them, even when both carry identical evidence and one is just a retry.
  // Sorted, every recording takes those locks in the same sequence, so no cycle
  // can form between two of them. That is the whole claim: a writer outside this
  // function, such as a learner's deletion cascading here, takes its own order.
  // The learner is the same across a batch, so the ID alone orders it.
  const inOrder = evidence
    .map((record) => ({ ...record, learnerId }))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  await database.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(learnerEvidence)
      .values(inOrder)
      // Named rather than left bare, so a unique index added later raises instead
      // of being swallowed as though it were a redelivery.
      .onConflictDoNothing({ target: [learnerEvidence.learnerId, learnerEvidence.id] })
      .returning({ id: learnerEvidence.id });

    // Every record went in exactly as sent, so none can disagree with anything.
    // The usual case, and it costs no second query.
    if (inserted.length === evidence.length) return;

    const rows = await transaction
      .select({
        id: learnerEvidence.id,
        objectiveId: learnerEvidence.objectiveId,
        outcome: learnerEvidence.outcome,
        at: learnerEvidence.at,
      })
      .from(learnerEvidence)
      .where(
        and(
          eq(learnerEvidence.learnerId, learnerId),
          inArray(learnerEvidence.id, [...new Set(evidence.map((record) => record.id))]),
        ),
      );
    const stored = new Map(rows.map((row) => [row.id, row]));

    const conflicting = new Set(
      evidence
        .filter((record) => !isSameResult(record, stored.get(record.id)))
        .map((record) => record.id),
    );
    // Thrown inside the transaction, so the rows this batch did insert are
    // rolled back with it: a batch is recorded whole or not at all.
    if (conflicting.size > 0) throw new ConflictingEvidence([...conflicting]);
  });
}

/**
 * Whether a stored row holds the result that was sent. A missing row counts as
 * a disagreement: the insert above leaves one behind for every ID, so its
 * absence means something removed it meanwhile, and refusing is the safe reading.
 */
function isSameResult(sent: Evidence, stored: Evidence | undefined): boolean {
  return (
    stored !== undefined &&
    stored.objectiveId === sent.objectiveId &&
    stored.outcome === sent.outcome &&
    stored.at.getTime() === sent.at.getTime()
  );
}

/**
 * Every record a learner's estimates are derived from as of one instant, ready
 * to hand to `replay`.
 *
 * Reads the learner's whole history rather than only the objectives a given
 * decision will consult. Narrowing it looks obviously right — replay folds each
 * objective independently, so the rest cannot reach the answer — and was tried
 * and measured. It made this read slower, not faster, for reasons that belong to
 * the query planner rather than to the model; the numbers and the reasoning are
 * in docs/adr/0009-evidence-is-read-whole.md. Read that before narrowing it.
 *
 * `asOf` is required rather than optional because a decision is made at a time,
 * and evidence dated after that instant is not part of it. A caller that read
 * everything and then selected against an earlier `now` would be handed a
 * learner whose last evidence lies in the future, which the model rejects — a
 * concurrent grader writing between the two is enough to cause it.
 *
 * The bound is on when the learner produced the evidence, not on when it was
 * written: a record that arrives late but is dated earlier belongs to this
 * result, which is the same property that lets replay absorb late arrivals.
 *
 * Ordered by `(at, id)` because the replay index serves it for free
 * and unordered rows are needlessly hard to read. Nothing depends on that
 * order: `replay` sorts again, which is also what absorbs the difference
 * between Postgres's collation for `id` and the code-unit comparison the model
 * orders by — they can disagree, and it cannot matter.
 */
export async function readLearnerEvidence(
  database: Database,
  learnerId: string,
  asOf: Date,
): Promise<Evidence[]> {
  return database
    .select({
      id: learnerEvidence.id,
      objectiveId: learnerEvidence.objectiveId,
      outcome: learnerEvidence.outcome,
      at: learnerEvidence.at,
    })
    .from(learnerEvidence)
    .where(and(eq(learnerEvidence.learnerId, learnerId), lte(learnerEvidence.at, asOf)))
    .orderBy(asc(learnerEvidence.at), asc(learnerEvidence.id));
}
