// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { objective } from "@braivo/db/schema";
import {
  clearEvidence,
  clearLearningData,
  seedOrganization,
  sharedDatabase,
  violatedConstraint,
} from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { activeModel, type Evidence, replay } from "../learning/index.ts";
import { ConflictingEvidence, readLearnerEvidence, recordEvidence } from "./evidence.ts";
import { createObjectives } from "./objective.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "evidence-test-org";
const learner = "evidence-test-learner";
const otherLearner = "evidence-test-other-learner";
const start = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number) => new Date(start.getTime() + days * 86_400_000);

let pastTense!: string;
let fractions!: string;

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", objectiveId: pastTense, outcome: "success", at: start, ...overrides };
}

const learnerIds = [learner, otherLearner];
/** Later than any evidence these tests record, for the cases not about the bound. */
const whenever = at(1000);

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("learner evidence", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds, at: start });

    const objectives = await createObjectives(database, organizationId, [
      "Past tense",
      "Fractions",
    ]);
    pastTense = objectives[0]!;
    fractions = objectives[1]!;
  });

  beforeEach(async () => {
    await clearEvidence(database, learnerIds);
  });

  test("keeps a learner's evidence when another organization's is cleared", async () => {
    const otherOrganizationId = "evidence-test-other-org";
    await seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [learner],
      at: start,
    });
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Past tense"]);
    await recordEvidence(database, learner, [
      evidence({ id: "mine" }),
      evidence({ id: "theirs", objectiveId: theirs! }),
    ]);

    await clearLearningData(database, otherOrganizationId);

    const kept = await readLearnerEvidence(database, learner, whenever);
    expect(kept.map((record) => record.id)).toEqual(["mine"]);
  });

  test("reads back what was recorded, in replay order", async () => {
    await recordEvidence(database, learner, [
      evidence({ id: "e2", at: at(2) }),
      evidence({ id: "e1", objectiveId: fractions, outcome: "failure", at: at(1) }),
    ]);

    expect(await readLearnerEvidence(database, learner, whenever)).toEqual([
      { id: "e1", objectiveId: fractions, outcome: "failure", at: at(1) },
      { id: "e2", objectiveId: pastTense, outcome: "success", at: at(2) },
    ]);
  });

  test("reads colliding timestamps in ID order, whatever order they arrived in", async () => {
    // Two calls, so the rows are written "b" first: one call would sort them.
    await recordEvidence(database, learner, [evidence({ id: "b" })]);
    await recordEvidence(database, learner, [evidence({ id: "a", outcome: "failure" })]);

    const read = await readLearnerEvidence(database, learner, whenever);

    expect(read.map((record) => record.id)).toEqual(["a", "b"]);
  });

  test("refuses evidence about an objective that does not exist", async () => {
    // Without the foreign key this would record knowledge of nothing, silently
    // and permanently, and replay would then attribute estimates to it.
    const error = await recordEvidence(database, learner, [
      evidence({ objectiveId: "no-such-objective" }),
    ]).catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("learner_evidence_objective_id_objective_id_fk");
  });

  test("refuses to delete an objective that evidence depends on", async () => {
    // Restricting the delete is the schema's only way to stop an objective
    // vanishing out from under the history attributed to it.
    await recordEvidence(database, learner, [evidence({ id: "depends-on-it" })]);

    const error = await database
      .delete(objective)
      .where(eq(objective.id, pastTense))
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("learner_evidence_objective_id_objective_id_fk");
  });

  test("stores a redelivered result once, and says nothing about it", async () => {
    await recordEvidence(database, learner, [evidence({ id: "retried" })]);
    await recordEvidence(database, learner, [evidence({ id: "retried" })]);

    expect(await readLearnerEvidence(database, learner, whenever)).toEqual([
      { id: "retried", objectiveId: pastTense, outcome: "success", at: start },
    ]);
  });

  // One field at a time, because the comparison is per field: a test changing
  // all three at once would pass with only one of them actually compared.
  // Functions, so each change is built inside its test, after `beforeAll` has
  // created the objectives it names.
  const disagreements: [string, () => Partial<Evidence>][] = [
    ["outcome", () => ({ outcome: "failure" })],
    ["date", () => ({ at: at(3) })],
    ["objective", () => ({ objectiveId: fractions })],
  ];
  for (const [field, change] of disagreements) {
    test(`refuses a redelivery whose ${field} disagrees, and keeps the first`, async () => {
      await recordEvidence(database, learner, [evidence({ id: "reused" })]);

      const refused = recordEvidence(database, learner, [evidence({ id: "reused", ...change() })]);

      await expect(refused).rejects.toBeInstanceOf(ConflictingEvidence);
      expect(await readLearnerEvidence(database, learner, whenever)).toEqual([
        { id: "reused", objectiveId: pastTense, outcome: "success", at: start },
      ]);
    });
  }

  test("stores nothing from a batch that disagrees with something already stored", async () => {
    // The batch's new records are inserted before the disagreement is found, so
    // this is the rollback, not merely the check.
    await recordEvidence(database, learner, [evidence({ id: "reused" })]);

    await expect(
      recordEvidence(database, learner, [
        evidence({ id: "new", at: at(1) }),
        evidence({ id: "reused", outcome: "failure" }),
      ]),
    ).rejects.toThrow('"reused"');

    expect((await readLearnerEvidence(database, learner, whenever)).map((row) => row.id)).toEqual([
      "reused",
    ]);
  });

  test("refuses a batch that contradicts itself", async () => {
    // The insert keeps the first copy and skips the second without a word, so
    // the check has to look at every record sent, not only at the ones skipped.
    await expect(
      recordEvidence(database, learner, [
        evidence({ id: "twice" }),
        evidence({ id: "twice", outcome: "failure" }),
      ]),
    ).rejects.toBeInstanceOf(ConflictingEvidence);

    expect(await readLearnerEvidence(database, learner, whenever)).toEqual([]);
  });

  test("refuses one of two disagreeing results that arrive at the same time", async () => {
    // Why the comparison reads what is stored after inserting rather than
    // before. Checked first, both writers see an empty table, both proceed, and
    // the insert quietly drops whichever lost — measured failing 599 races in
    // 600. Ten races make that all but impossible to miss.
    for (let race = 0; race < 10; race++) {
      await clearEvidence(database, learnerIds);
      const [succeeded, failed] = await Promise.allSettled([
        recordEvidence(database, learner, [evidence({ id: "raced", outcome: "success" })]),
        recordEvidence(database, learner, [evidence({ id: "raced", outcome: "failure" })]),
      ]);

      const outcomes = [succeeded, failed].map((settled) => settled.status);
      expect(outcomes.toSorted()).toEqual(["fulfilled", "rejected"]);
      const loser = succeeded.status === "rejected" ? succeeded : failed;
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(ConflictingEvidence);

      // And what is stored is the write that was told it succeeded.
      const winner = succeeded.status === "fulfilled" ? "success" : "failure";
      expect(
        (await readLearnerEvidence(database, learner, whenever)).map((row) => row.outcome),
      ).toEqual([winner]);
    }
  });

  test("accepts overlapping batches that arrive at once in opposite orders", async () => {
    // A retry racing its original, sent in a different order. Inserted in
    // arrival order, each writer could lock a row the other needed next, and
    // PostgreSQL would fail one of them with a deadlock — which is what the
    // insert this replaced did in 20 races out of 20 at 200 records, for
    // evidence identical on both sides.
    const batch = Array.from({ length: 100 }, (_unused, index) =>
      evidence({ id: `overlap-${String(index).padStart(3, "0")}`, at: at(index) }),
    );

    for (let race = 0; race < 10; race++) {
      await clearEvidence(database, learnerIds);
      await Promise.all([
        recordEvidence(database, learner, batch),
        recordEvidence(database, learner, batch.toReversed()),
      ]);

      expect(await readLearnerEvidence(database, learner, whenever)).toHaveLength(100);
    }
  });

  test("records the new part of a batch that also redelivers something", async () => {
    // The path where a comparison runs and finds nothing wrong.
    await recordEvidence(database, learner, [evidence({ id: "retried" })]);

    await recordEvidence(database, learner, [
      evidence({ id: "retried" }),
      evidence({ id: "new", at: at(1) }),
    ]);

    expect((await readLearnerEvidence(database, learner, whenever)).map((row) => row.id)).toEqual([
      "retried",
      "new",
    ]);
  });

  test("accepts the same result twice within one batch", async () => {
    const graded = evidence({ id: "twice" });

    await recordEvidence(database, learner, [graded, graded]);

    expect(await readLearnerEvidence(database, learner, whenever)).toHaveLength(1);
  });

  test("keeps one learner's evidence out of another's history", async () => {
    await recordEvidence(database, learner, [evidence({ id: "mine" })]);
    await recordEvidence(database, otherLearner, [evidence({ id: "theirs" })]);

    expect(await readLearnerEvidence(database, learner, whenever)).toEqual([
      { id: "mine", objectiveId: pastTense, outcome: "success", at: start },
    ]);
  });

  test("keeps colliding IDs from different learners instead of dropping one", async () => {
    // A grader that builds IDs from task and objective rather than from the
    // attempt produces exactly this; a globally keyed table would silently lose
    // whichever learner's evidence arrived second.
    await recordEvidence(database, learner, [evidence({ id: "shared" })]);
    await recordEvidence(database, otherLearner, [evidence({ id: "shared" })]);

    expect(await readLearnerEvidence(database, learner, whenever)).toHaveLength(1);
    expect(await readLearnerEvidence(database, otherLearner, whenever)).toHaveLength(1);
  });

  test("leaves out evidence dated after the instant asked about", async () => {
    // A decision is made at a time, and a grader writing concurrently must not
    // retroactively become part of one already in flight.
    await recordEvidence(database, learner, [
      evidence({ id: "before", at: at(1) }),
      evidence({ id: "after", at: at(3) }),
    ]);

    expect(await readLearnerEvidence(database, learner, at(2))).toEqual([
      { id: "before", objectiveId: pastTense, outcome: "success", at: at(1) },
    ]);
  });

  test("includes evidence dated at exactly that instant", async () => {
    await recordEvidence(database, learner, [evidence({ id: "exactly", at: at(2) })]);

    expect(await readLearnerEvidence(database, learner, at(2))).toHaveLength(1);
  });

  test("records nothing, and does not fail, for an empty batch", async () => {
    await recordEvidence(database, learner, []);

    expect(await readLearnerEvidence(database, learner, whenever)).toEqual([]);
  });

  test("stored evidence replays to the same estimates as the records in memory", async () => {
    // The point of preserving evidence is that estimates can be rebuilt from it,
    // so the round trip has to survive the database — timestamps included.
    const history = [
      evidence({ id: "e1", objectiveId: pastTense, outcome: "failure", at: at(0) }),
      evidence({ id: "e2", objectiveId: fractions, at: at(0) }),
      evidence({ id: "e3", objectiveId: pastTense, at: at(1) }),
      evidence({ id: "e4", objectiveId: fractions, outcome: "failure", at: at(5) }),
      evidence({ id: "e5", objectiveId: pastTense, at: at(9.5) }),
    ];
    await recordEvidence(database, learner, history);

    const stored = await readLearnerEvidence(database, learner, whenever);

    expect(replay(stored, activeModel)).toEqual(replay(history, activeModel));
  });
});
