// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";

import { runMigrations } from "@braivo/db";
import {
  attempt,
  group,
  groupMember,
  invitation,
  learnerEvidence,
  learnerHandoff,
  learnerHistoryState,
  learnerSession,
  learnerSignInCode,
  member,
  taskReport,
  user,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import {
  createCourse,
  createObjectives,
  withLearnerHistoryLock,
  recordAttempt,
} from "../persistence/index.ts";
import { chooseNextActivity, submitAttempt } from "./activity.ts";
import {
  eraseLearnerHistory,
  previewHistoryErasure,
  type HistoryErasureTarget,
} from "./erase-history.ts";
import type { ErasureRecord } from "./erasure-log.ts";
import type { RequestHost } from "./host.ts";
import { readLearnerProgress } from "./learner-progress.ts";
import { recordGradedEvidence } from "./record-evidence.ts";

// One school's history erased, and it stays erased (ADR 0053): what the erasure
// removes and keeps, and every way an old answer might bring it back. A second
// learner and a second school hold the same IDs, so a delete or a fence missing
// either in its predicate fails here.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const prefix = "erase-history-test";
const fernwood = `${prefix}-fernwood`;
const birchwood = `${prefix}-birchwood`;
const ada = `${prefix}-ada`;
const ben = `${prefix}-ben`;
const owner = `${prefix}-owner`;
const adaEmail = `${ada}@example.com`;
const host: RequestHost = { hostname: "localhost", installation: true };
const secret = "erasure-log-test-key-that-is-long-enough";

const question = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong"],
  answer: 0,
});

/** The log's store in memory, each write kept, in order. */
function memoryLog() {
  const writes: { key: string; record: ErasureRecord }[] = [];
  return {
    writes,
    store: {
      put: async (key: string, bytes: Uint8Array) => {
        writes.push({ key, record: JSON.parse(new TextDecoder().decode(bytes)) });
      },
    },
    hmacKey: secret,
  };
}

type School = { courseId: string; objectiveId: string; tasks: string[] };

async function school(organizationId: string): Promise<School> {
  const [objectiveId] = await createObjectives(database, organizationId, ["Greetings"]);
  const tasks = [];
  for (const prompt of ["One?", "Two?", "Three?"]) {
    tasks.push(
      await testing.createTask(database, {
        organizationId,
        objectiveId: objectiveId!,
        body: question(prompt),
        createdAt: new Date(Date.now() - 86_400_000),
      }),
    );
  }
  const { id } = await createCourse(database, {
    published: true,
    organizationId,
    title: "Course",
    objectiveIds: [objectiveId!],
  });
  return { courseId: id, objectiveId: objectiveId!, tasks };
}

let fern!: School;
let birch!: School;

function answer(
  at: School,
  learnerId: string,
  input: { id: string; task?: number; epoch: number; now?: Date },
) {
  return submitAttempt({
    database,
    learnerId,
    courseId: at.courseId,
    host,
    attemptId: input.id,
    taskId: at.tasks[input.task ?? 0]!,
    response: { choice: 0 },
    historyEpoch: input.epoch,
    now: input.now ?? new Date(),
  });
}

function grade(
  learnerId: string,
  input: { id: string; at: Date; epoch?: number; now?: Date; school?: School; org?: string },
) {
  return recordGradedEvidence({
    database,
    organizationId: input.org ?? fernwood,
    gradedBy: owner,
    learnerId,
    historyEpoch: input.epoch,
    evidence: [
      {
        id: input.id,
        objectiveId: (input.school ?? fern).objectiveId,
        outcome: "success",
        at: input.at,
      },
    ],
    now: input.now ?? new Date(),
  });
}

async function target(email = adaEmail, slug = fernwood): Promise<HistoryErasureTarget> {
  return (await previewHistoryErasure({ database, email, organizationSlug: slug })).target;
}

async function erase(options: { endMembership?: boolean } = {}) {
  const log = memoryLog();
  const result = await eraseLearnerHistory({
    database,
    target: await target(),
    endMembership: options.endMembership ?? false,
    log,
  });
  return { ...result, log };
}

const rows = async (learnerId: string, organizationId: string) => ({
  attempts: await database
    .select({ id: attempt.id })
    .from(attempt)
    .where(and(eq(attempt.learnerId, learnerId), eq(attempt.organizationId, organizationId))),
  evidence: await database
    .select({ id: learnerEvidence.id })
    .from(learnerEvidence)
    .where(
      and(
        eq(learnerEvidence.learnerId, learnerId),
        eq(learnerEvidence.organizationId, organizationId),
      ),
    ),
});

const counted = async (learnerId: string, organizationId: string) => {
  const { attempts, evidence } = await rows(learnerId, organizationId);
  return { attempts: attempts.length, evidence: evidence.length };
};

const fence = async (learnerId = ada, organizationId = fernwood) => {
  const [row] = await database
    .select()
    .from(learnerHistoryState)
    .where(
      and(
        eq(learnerHistoryState.learnerId, learnerId),
        eq(learnerHistoryState.organizationId, organizationId),
      ),
    );
  return row;
};

const addToSchool = (organizationId: string, userId: string, role = "member") =>
  database.insert(member).values({
    id: `${organizationId}:${userId}`,
    organizationId,
    userId,
    role,
    createdAt: new Date(),
  });

const future = (ms: number) => new Date(Date.now() + ms);

/** Until some statement like `pattern` (SQL `like`) waits for another transaction's lock. */
async function waitForLock(pattern: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    const waiting = await database.execute(
      sql`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like ${pattern}`,
      "objects",
    );
    if (waiting.length > 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`No statement like ${pattern} waited for a lock.`);
}

/** The learner's lock, as `withLearnerHistoryLock` takes it. */
const untilWaitingForLearner = () => waitForLock("%pg_advisory_xact_lock%::text%");

/** Requires TEST_DATABASE_URL: locks and cascades are the database's. */
describe.skipIf(!connectionString)("erasing one school's history", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await testing.clearLearnerHistory(database, [ada, ben, owner]);
    const at = new Date("2026-06-01T00:00:00.000Z");
    for (const organizationId of [fernwood, birchwood]) {
      await testing.seedOrganization(database, {
        organizationId,
        learnerIds: [ada, ben],
        adminIds: [owner],
        at,
      });
    }
    await database.update(member).set({ role: "owner" }).where(eq(member.userId, owner));
    await database
      .delete(learnerHistoryState)
      .where(inArray(learnerHistoryState.learnerId, [ada, ben, owner]));
    await database.delete(learnerSession).where(inArray(learnerSession.userId, [ada, ben]));
    await database
      .delete(learnerHandoff)
      .where(inArray(learnerHandoff.organizationId, [fernwood, birchwood]));
    await database
      .delete(learnerSignInCode)
      .where(inArray(learnerSignInCode.organizationId, [fernwood, birchwood]));
    await database
      .delete(invitation)
      .where(inArray(invitation.organizationId, [fernwood, birchwood]));
    fern = await school(fernwood);
    birch = await school(birchwood);
  });

  describe("what it removes and keeps", () => {
    const hour = () => future(3_600_000);

    async function seedEverything() {
      for (const [learnerId, at] of [
        [ada, fern],
        [ben, fern],
        [ada, birch],
      ] as const) {
        expect(await answer(at, learnerId, { id: "same-id", epoch: 0 })).toMatchObject({
          kind: "graded",
        });
      }
      await grade(ada, { id: "outside", at: new Date() });
      await grade(ben, { id: "outside", at: new Date() });
      await grade(ada, { id: "outside", at: new Date(), org: birchwood, school: birch });
      await database.insert(taskReport).values([
        {
          id: `${prefix}-report-ada`,
          learnerId: ada,
          organizationId: fernwood,
          attemptId: "same-id",
          taskId: fern.tasks[0]!,
          reason: "other",
          note: "Ada's",
          createdAt: new Date(),
        },
        {
          id: `${prefix}-report-ben`,
          learnerId: ben,
          organizationId: fernwood,
          attemptId: "same-id",
          taskId: fern.tasks[0]!,
          reason: "other",
          note: "Ben's",
          createdAt: new Date(),
        },
        {
          id: `${prefix}-report-ada-birchwood`,
          learnerId: ada,
          organizationId: birchwood,
          attemptId: "same-id",
          taskId: birch.tasks[0]!,
          reason: "other",
          note: "Ada's at Birchwood",
          createdAt: new Date(),
        },
      ]);
      await database.insert(learnerSession).values(
        [
          [ada, fernwood],
          [ben, fernwood],
          [ada, birchwood],
        ].map(([userId, organizationId], index) => ({
          tokenHash: `${prefix}-session-${index}`,
          userId: userId!,
          organizationId: organizationId!,
          hostname: `${organizationId}.example`,
          expiresAt: hour(),
        })),
      );
      await database.insert(learnerHandoff).values(
        [
          [ada, fernwood],
          [ben, fernwood],
          [ada, birchwood],
          [null, fernwood],
        ].map(([userId, organizationId], index) => ({
          id: `${prefix}-handoff-${index}`,
          organizationId: organizationId!,
          hostname: `${organizationId}.example`,
          returnPath: "/",
          nonceHash: `${prefix}-nonce-${index}`,
          userId,
          expiresAt: hour(),
        })),
      );
      await database.insert(learnerSignInCode).values(
        [
          [adaEmail, fernwood, "a.example"],
          [adaEmail, fernwood, "b.example"],
          [`${ben}@example.com`, fernwood, "a.example"],
          [adaEmail, birchwood, "c.example"],
        ].map(([email, organizationId, hostname]) => ({
          email: email!,
          organizationId: organizationId!,
          hostname: hostname!,
          codeSeed: "seed",
          expiresAt: hour(),
          resendAt: hour(),
        })),
      );
      await database.insert(invitation).values(
        [
          [adaEmail, fernwood],
          // As an address may have been stored before it was normalized.
          [adaEmail.toUpperCase(), fernwood],
          [`${ben}@example.com`, fernwood],
          [adaEmail, birchwood],
        ].map(([email, organizationId], index) => ({
          id: `${prefix}-invitation-${index}`,
          email: email!,
          organizationId: organizationId!,
          status: "pending",
          expiresAt: hour(),
          createdAt: new Date(),
          inviterId: owner,
        })),
      );
    }

    test("counts what it will remove, and removes that at this school alone", async () => {
      await seedEverything();

      const found = await previewHistoryErasure({
        database,
        // As sign-in normalizes it.
        email: `  ${adaEmail.toUpperCase()} `,
        organizationSlug: fernwood,
      });
      const expected = {
        attempts: 1,
        evidence: 2,
        reports: 1,
        sessions: 1,
        handoffs: 1,
        signInCodes: 2,
        invitations: 2,
      };
      expect(found.target).toEqual({
        learnerId: ada,
        email: adaEmail,
        organizationId: fernwood,
        organizationSlug: fernwood,
      });
      expect(found.counts).toEqual(expected);
      expect(found.epoch).toBe(0);

      const { removed, epoch } = await erase();
      expect(removed).toEqual({ ...expected, membership: false });
      expect(epoch).toBe(1);

      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
      // The other learner at this school, under the same IDs.
      expect(await counted(ben, fernwood)).toEqual({ attempts: 1, evidence: 2 });
      // The other school, under the same IDs.
      expect(await counted(ada, birchwood)).toEqual({ attempts: 1, evidence: 2 });

      const reports = await database
        .select({ note: taskReport.note })
        .from(taskReport)
        .where(inArray(taskReport.learnerId, [ada, ben]));
      expect(reports).toHaveLength(2);
      expect(reports).toContainEqual({ note: "Ada's at Birchwood" });
      expect(reports).toContainEqual({ note: "Ben's" });

      const sessions = await database
        .select({ userId: learnerSession.userId, organizationId: learnerSession.organizationId })
        .from(learnerSession)
        .where(inArray(learnerSession.userId, [ada, ben]));
      expect(sessions).toHaveLength(2);
      expect(sessions).not.toContainEqual({ userId: ada, organizationId: fernwood });

      const handoffs = await database
        .select({ userId: learnerHandoff.userId, organizationId: learnerHandoff.organizationId })
        .from(learnerHandoff)
        .where(inArray(learnerHandoff.organizationId, [fernwood, birchwood]));
      // The learner's linked handoff at this school is gone; another's, another
      // school's, and one nobody completed yet stay.
      expect(handoffs).toHaveLength(3);
      expect(handoffs).not.toContainEqual({ userId: ada, organizationId: fernwood });
      expect(handoffs).toContainEqual({ userId: null, organizationId: fernwood });

      const codes = await database
        .select({ email: learnerSignInCode.email, org: learnerSignInCode.organizationId })
        .from(learnerSignInCode)
        .where(inArray(learnerSignInCode.organizationId, [fernwood, birchwood]));
      expect(codes).toHaveLength(2);
      expect(codes).not.toContainEqual({ email: adaEmail, org: fernwood });

      const invitations = await database
        .select({ email: invitation.email, org: invitation.organizationId })
        .from(invitation)
        .where(inArray(invitation.organizationId, [fernwood, birchwood]));
      expect(invitations).toHaveLength(2);
      expect(invitations).toContainEqual({ email: adaEmail, org: birchwood });

      // Kept unless asked: the learner's next answers start afresh.
      expect(
        await database
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.userId, ada), eq(member.organizationId, fernwood))),
      ).toHaveLength(1);
      // The account's own sessions and the other school's fence, untouched.
      expect(await fence(ada, birchwood)).toBeUndefined();
    });

    test("a report read right after shows nothing, and practice starts fresh", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      await grade(ada, { id: "outside", at: new Date() });

      const before = await readLearnerProgress({
        database,
        viewedBy: ada,
        accessKind: "browser",
        learnerId: ada,
        courseId: fern.courseId,
        host,
        now: new Date(),
      });
      expect(before).toMatchObject({ kind: "assessed", report: { historyEpoch: 0 } });

      await erase();

      const after = await readLearnerProgress({
        database,
        viewedBy: ada,
        accessKind: "browser",
        learnerId: ada,
        courseId: fern.courseId,
        host,
        now: future(1_000),
      });
      expect(after).toMatchObject({
        kind: "assessed",
        report: {
          historyEpoch: 1,
          lastPractisedAt: null,
          objectives: [{ phase: "unseen", evidence: [] }],
        },
      });

      const next = await chooseNextActivity({
        database,
        learnerId: ada,
        courseId: fern.courseId,
        host,
        now: future(1_000),
        timeZone: "UTC",
      });
      expect(next).toMatchObject({
        kind: "decided",
        historyEpoch: 1,
        decision: { intent: "introduce" },
      });
    });

    test("names a stranger to nobody: no record of them here is refused, writing nothing", async () => {
      await database.delete(member).where(eq(member.userId, ada));
      await expect(
        previewHistoryErasure({ database, email: adaEmail, organizationSlug: fernwood }),
      ).rejects.toThrow(/nothing/i);
      await expect(
        previewHistoryErasure({
          database,
          email: "nobody@example.com",
          organizationSlug: fernwood,
        }),
      ).rejects.toThrow(/No account/);
      await expect(
        previewHistoryErasure({ database, email: adaEmail, organizationSlug: "no-such-school" }),
      ).rejects.toThrow(/No organization/);
      expect(await fence()).toBeUndefined();
    });

    test("a rerun finds the fence, bumps it, and removes nothing", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      await erase({ endMembership: true });
      const { epoch, removed } = await erase({ endMembership: true });
      expect(epoch).toBe(2);
      expect(removed).toMatchObject({ attempts: 0, evidence: 0, membership: false });
    });
  });

  describe("ending membership", () => {
    test("ends it with its groups, and an old resend stays refused after rejoining", async () => {
      const groupId = `${prefix}-group`;
      await database
        .insert(group)
        .values({ id: groupId, organizationId: fernwood, name: "Class", creationDigest: "x" });
      await database
        .insert(groupMember)
        .values({ organizationId: fernwood, groupId, userId: ada, role: "learner" });
      await answer(fern, ada, { id: "old", epoch: 0 });

      const { removed } = await erase({ endMembership: true });
      expect(removed.membership).toBe(true);
      expect(
        await database.select({ id: member.id }).from(member).where(eq(member.userId, ada)),
      ).toHaveLength(1); // Birchwood's alone.
      expect(
        await database
          .select({ user: groupMember.userId })
          .from(groupMember)
          .where(eq(groupMember.userId, ada)),
      ).toEqual([]);
      // Not a member: refused as any stranger's answer.
      expect(await answer(fern, ada, { id: "while-out", epoch: 1 })).toEqual({
        kind: "unavailable",
      });

      // The fence is not membership's, so rejoining leaves it.
      await addToSchool(fernwood, ada);
      expect(await answer(fern, ada, { id: "old", epoch: 0 })).toEqual({ kind: "history-erased" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("never takes an organization's only owner, erasing nothing", async () => {
      await answer(fern, owner, { id: "theirs", epoch: 0 });
      const log = memoryLog();
      const refused = eraseLearnerHistory({
        database,
        target: await target(`${owner}@example.com`),
        endMembership: true,
        log,
      });
      await expect(refused).rejects.toThrow(/only owner/);
      expect(await counted(owner, fernwood)).toEqual({ attempts: 1, evidence: 1 });
      expect(await fence(owner)).toBeUndefined();
      // Refused, so no intent a replay would carry out.
      expect(log.writes).toEqual([]);
    });

    test("erases an only owner's history when their membership stays", async () => {
      await answer(fern, owner, { id: "theirs", epoch: 0 });
      await eraseLearnerHistory({
        database,
        target: await target(`${owner}@example.com`),
        endMembership: false,
        log: memoryLog(),
      });
      expect(await counted(owner, fernwood)).toEqual({ attempts: 0, evidence: 0 });
      expect(await fence(owner)).toMatchObject({ epoch: 1 });
    });
  });

  test("two owners ending their memberships at once leave one, whichever goes first", async () => {
    await database
      .update(member)
      .set({ role: "owner" })
      .where(and(eq(member.userId, ada), eq(member.organizationId, fernwood)));
    let blocked: Promise<void> | undefined;
    const slow = {
      hmacKey: secret,
      store: {
        // Holding its turn until the other waits for it: unserialized, both would
        // pass their owner check, and neither ever wait.
        put: () => (blocked ??= waitForLock("%for update%")),
      },
    };
    const results = await Promise.allSettled(
      [adaEmail, `${owner}@example.com`].map(async (email) =>
        eraseLearnerHistory({
          database,
          target: await target(email),
          endMembership: true,
          log: slow,
        }),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const owners = await database
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, fernwood), eq(member.role, "owner")));
    expect(owners).toHaveLength(1);
  });

  describe("an attempt", () => {
    test("a delayed resend from before the erasure is refused, recording nothing", async () => {
      await erase();
      expect(await answer(fern, ada, { id: "delayed", epoch: 0 })).toEqual({
        kind: "history-erased",
      });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
      // The other learner and the other school are on their own epochs.
      expect(await answer(fern, ben, { id: "delayed", epoch: 0 })).toMatchObject({
        kind: "graded",
      });
      expect(await answer(birch, ada, { id: "delayed", epoch: 0 })).toMatchObject({
        kind: "graded",
      });
    });

    test("under the current epoch, it starts the fresh history", async () => {
      await erase();
      expect(await answer(fern, ada, { id: "fresh", epoch: 1 })).toMatchObject({ kind: "graded" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 1, evidence: 1 });
    });

    test("a recorded attempt's resend answers its outcome, whatever its epoch", async () => {
      await answer(fern, ada, { id: "kept", epoch: 0 });
      for (const epoch of [0, 7]) {
        expect(await answer(fern, ada, { id: "kept", epoch })).toMatchObject({
          kind: "graded",
          grade: { outcome: "success" },
        });
      }
      // The same ID with another task is still its conflict, not an epoch's.
      expect(await answer(fern, ada, { id: "kept", task: 1, epoch: 7 })).toEqual({
        kind: "conflict",
      });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 1, evidence: 1 });
    });

    test("an epoch nothing ever issued is refused, not trusted", async () => {
      expect(await answer(fern, ada, { id: "ahead", epoch: 3 })).toEqual({
        kind: "history-erased",
      });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("in flight during an erasure, it lands before it and is erased", async () => {
      // An attempt holding the lock, recorded and uncommitted, as a slow writer is.
      let erasing!: Promise<unknown>;
      await withLearnerHistoryLock(
        database,
        { learnerId: ada, organizationId: fernwood },
        async (transaction) => {
          await recordAttempt(transaction, {
            learnerId: ada,
            organizationId: fernwood,
            attemptId: "in-flight",
            taskId: fern.tasks[0]!,
            response: { choice: 0 },
            at: new Date(),
            restWindowStart: new Date(0),
            restAttempts: 3,
            staleEpoch: false,
            evidence: {
              id: "attempt:in-flight:x",
              objectiveId: fern.objectiveId,
              outcome: "success",
            },
          });
          let finished = false;
          erasing = erase().finally(() => (finished = true));
          await untilWaitingForLearner();
          expect(finished).toBe(false);
        },
      );
      await erasing;
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("in flight during an erasure, after it, it is refused", async () => {
      await answer(fern, ada, { id: "earlier", epoch: 0 });
      const log = memoryLog();
      let submitted!: Promise<Awaited<ReturnType<typeof answer>>>;
      let released!: () => void;
      const held = new Promise<void>((resolve) => (released = resolve));
      const erasing = eraseLearnerHistory({
        database,
        target: await target(),
        endMembership: false,
        log: {
          hmacKey: secret,
          store: {
            // The intent's write: the erasure holds the lock, nothing deleted yet.
            put: async (key, bytes) => {
              await log.store.put(key, bytes);
              if (log.writes.length === 1) {
                submitted = answer(fern, ada, { id: "racing", task: 1, epoch: 0 });
                await untilWaitingForLearner();
                released();
              }
            },
          },
        },
      });
      await held;
      await erasing;
      expect(await submitted).toEqual({ kind: "history-erased" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("membership is read under the lock, so one ended meanwhile refuses the attempt", async () => {
      const log = memoryLog();
      let submitted!: Promise<Awaited<ReturnType<typeof answer>>>;
      const erasing = eraseLearnerHistory({
        database,
        target: await target(),
        endMembership: true,
        log: {
          hmacKey: secret,
          store: {
            put: async (key, bytes) => {
              await log.store.put(key, bytes);
              if (log.writes.length === 1) {
                // Under the epoch it will have once this commits: only membership stops it.
                submitted = answer(fern, ada, { id: "racing", epoch: 1 });
                await untilWaitingForLearner();
              }
            },
          },
        },
      });
      await erasing;
      expect(await submitted).toEqual({ kind: "unavailable" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });
  });

  describe("outside evidence", () => {
    test("dated ahead, recorded, erased, and replayed without an epoch, it is refused", async () => {
      const dated = future(60_000);
      await grade(ada, { id: "ahead", at: dated });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 1 });

      await erase();
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });

      await expect(grade(ada, { id: "ahead", at: dated })).rejects.toMatchObject({
        name: "HistoryErased",
      });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("a retry dated before the erasure is refused, a whole batch with it", async () => {
      const before = new Date(Date.now() - 60_000);
      await erase();
      await expect(grade(ada, { id: "retry", at: before })).rejects.toMatchObject({
        name: "HistoryErased",
      });
      await expect(
        recordGradedEvidence({
          database,
          organizationId: fernwood,
          gradedBy: owner,
          learnerId: ada,
          evidence: [
            { id: "new", objectiveId: fern.objectiveId, outcome: "success", at: future(600_000) },
            { id: "old", objectiveId: fern.objectiveId, outcome: "success", at: before },
          ],
          now: future(600_000),
        }),
      ).rejects.toMatchObject({ name: "HistoryErased" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });

    test("the tolerance is the future-dating rule's, its limit included", async () => {
      await erase();
      const { erasedAt } = (await fence())!;
      const limit = new Date(erasedAt!.getTime() + 5 * 60_000);
      // Recorded just before erasing, at the furthest ahead that was allowed.
      await expect(grade(ada, { id: "limit", at: limit, now: limit })).rejects.toMatchObject({
        name: "HistoryErased",
      });
      const past = new Date(limit.getTime() + 1);
      await grade(ada, { id: "past-limit", at: past, now: past });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 1 });
    });

    test("a stale epoch refuses the batch, and the current one takes an old date", async () => {
      await erase();
      const before = new Date(Date.now() - 60_000);
      await expect(grade(ada, { id: "stale", at: new Date(), epoch: 0 })).rejects.toMatchObject({
        name: "HistoryErased",
      });
      // It read the epoch after the erasure, so an old date proves nothing old.
      await grade(ada, { id: "current", at: before, epoch: 1 });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 1 });
    });

    test("never erased: no epoch and any past date are as they ever were", async () => {
      await grade(ada, { id: "import", at: new Date("2020-01-01T00:00:00.000Z") });
      await grade(ada, { id: "with-epoch", at: new Date(), epoch: 0 });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 2 });
    });

    test("waits for an erasure under way, and rechecks membership after it", async () => {
      const log = memoryLog();
      let recorded!: Promise<void>;
      const erasing = eraseLearnerHistory({
        database,
        target: await target(),
        endMembership: true,
        log: {
          hmacKey: secret,
          store: {
            put: async (key, bytes) => {
              await log.store.put(key, bytes);
              if (log.writes.length === 1) {
                recorded = grade(ada, { id: "racing", at: future(1_000), epoch: 1 });
                recorded.catch(() => {});
                await untilWaitingForLearner();
              }
            },
          },
        },
      });
      await erasing;
      await expect(recorded).rejects.toMatchObject({ name: "NotPermitted" });
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
    });
  });

  describe("the log", () => {
    test("holds the intent before anything is deleted, done only after commit", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      const seen: { attempts: number; doneAt: string | null }[] = [];
      const log = memoryLog();
      const before = Date.now();
      const result = await eraseLearnerHistory({
        database,
        target: await target(),
        endMembership: true,
        log: {
          hmacKey: secret,
          store: {
            put: async (key, bytes) => {
              await log.store.put(key, bytes);
              seen.push({
                attempts: (await counted(ada, fernwood)).attempts,
                doneAt: log.writes.at(-1)!.record.doneAt,
              });
            },
          },
        },
      });

      expect(seen[0]).toEqual({ attempts: 1, doneAt: null });
      expect(seen[1]).toMatchObject({ attempts: 0 });
      expect(seen[1]?.doneAt).toEqual(expect.any(String));
      // One record, replaced: its key is its ID.
      expect(log.writes[0]?.key).toBe(`${result.recordId}.json`);
      expect(log.writes[1]?.key).toBe(log.writes[0]?.key);

      const { record } = log.writes[1]!;
      expect(record).toEqual({
        format: "braivo-erasure-log",
        version: 1,
        id: result.recordId,
        scope: "organization",
        userId: ada,
        organizationId: fernwood,
        epoch: 1,
        endMembership: true,
        email: {
          hmac: createHmac("sha256", secret).update(adaEmail).digest("hex"),
          rule: "trim-lowercase-v1",
        },
        intentAt: expect.any(String),
        doneAt: expect.any(String),
      });
      expect(Date.parse(record.intentAt)).toBeGreaterThanOrEqual(before);
      // Holds no address, so reading the log alone names no one's email.
      expect(JSON.stringify(record)).not.toContain(adaEmail);
    });

    test("no intent, no erasure: a store that fails erases nothing", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      await expect(
        eraseLearnerHistory({
          database,
          target: await target(),
          endMembership: true,
          log: {
            hmacKey: secret,
            store: {
              put: async () => {
                throw new Error("store down");
              },
            },
          },
        }),
      ).rejects.toThrow(/store down/);
      expect(await counted(ada, fernwood)).toEqual({ attempts: 1, evidence: 1 });
      expect(await fence()).toBeUndefined();
    });

    test("failing once its intent is written, it names the record left pending and its epoch", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      const refused = eraseLearnerHistory({
        database,
        target: await target(),
        endMembership: false,
        log: {
          hmacKey: secret,
          store: {
            // Gone from under the erasure: its fence's foreign key then fails it.
            put: async (key) => {
              expect(key).toMatch(/\.json$/);
              await database.delete(user).where(eq(user.id, ada));
            },
          },
        },
      });
      await expect(refused).rejects.toThrow(/Log record \S+ is pending, for history epoch 1/);
    });

    test("committed with its entry left pending, it says so rather than done", async () => {
      await answer(fern, ada, { id: "first", epoch: 0 });
      let puts = 0;
      await expect(
        eraseLearnerHistory({
          database,
          target: await target(),
          endMembership: false,
          log: {
            hmacKey: secret,
            store: {
              put: async () => {
                if (++puts === 2) throw new Error("store down");
              },
            },
          },
        }),
      ).rejects.toThrow(/history was erased.*could not be marked done: store down/);
      expect(await counted(ada, fernwood)).toEqual({ attempts: 0, evidence: 0 });
      expect((await fence())?.epoch).toBe(1);
    });
  });

  test("epochs are read before history, so an erasure between them fences the answer", async () => {
    await answer(fern, ada, { id: "first", epoch: 0 });
    const statements: string[] = [];
    const recording = testing.recordingDatabase(connectionString ?? "", statements);
    try {
      await readLearnerProgress({
        database: recording,
        viewedBy: ada,
        accessKind: "browser",
        learnerId: ada,
        courseId: fern.courseId,
        host,
        now: new Date(),
      });
    } finally {
      await recording.$client.end();
    }
    const position = (table: string) =>
      statements.findIndex((statement) => statement.includes(`from "${table}"`));
    expect(position("learner_history_state")).toBeGreaterThanOrEqual(0);
    expect(position("learner_history_state")).toBeLessThan(position("learner_evidence"));
  });

  test("a deleted account takes its fence with it", async () => {
    await erase();
    await database.delete(user).where(eq(user.id, ada));
    expect(await fence()).toBeUndefined();
    // The next test's `seedOrganization` makes the account again.
  });
});
