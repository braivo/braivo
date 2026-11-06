// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";

import { runMigrations } from "@braivo/db";
import {
  accountErasure,
  aiRequest,
  attempt,
  deviceCode,
  invitation,
  learnerEvidence,
  learnerHandoff,
  learnerSession,
  learnerSignInCode,
  member,
  organization,
  taskReport,
  user,
  verification,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { TaskBody } from "../content/index.ts";
import { createCourse, createObjectives, withLearnerHistoryLock } from "../persistence/index.ts";
import { submitAttempt } from "./activity.ts";
import { eraseAccount, previewAccountErasure } from "./erase-account.ts";
import type { ErasureRecord } from "./erasure-log.ts";
import type { RequestHost } from "./host.ts";

// An account erased whole (access-49): what the transaction refuses, how it
// meets every other writer, and the record it leaves. Every row it removes is
// `persistence/learner-data-inventory.test.ts`'s.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const prefix = "erase-account-test";
const fernwood = `${prefix}-fernwood`;
const birchwood = `${prefix}-birchwood`;
const ada = `${prefix}-ada`;
const owner = `${prefix}-owner`;
const adaEmail = `${ada}@example.com`;
/** Contains Ada's address, as a substring search would find it. */
const longer = `jo${adaEmail}`;
const host: RequestHost = { hostname: "localhost", installation: true };
const secret = "erasure-log-test-key-that-is-long-enough";

const question = (prompt: string): TaskBody => ({
  kind: "choice",
  prompt,
  options: ["right", "wrong"],
  answer: 0,
});

function memoryLog(onIntent?: () => Promise<void>) {
  const writes: ErasureRecord[] = [];
  return {
    writes,
    hmacKey: secret,
    store: {
      put: async (_key: string, bytes: Uint8Array) => {
        writes.push(JSON.parse(new TextDecoder().decode(bytes)));
        if (writes.length === 1) await onIntent?.();
      },
    },
  };
}

const find = () => previewAccountErasure({ database, email: adaEmail });

async function erase(log = memoryLog()) {
  const { target } = await find();
  return { ...(await eraseAccount({ database, target, log })), log };
}

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

/** A learner's history lock, as `withLearnerHistoryLock` takes it. */
const untilWaitingForLearner = () => waitForLock("%pg_advisory_xact_lock%::text%");

let courseId = "";
let taskId = "";

const answer = (id: string) =>
  submitAttempt({
    database,
    learnerId: ada,
    courseId,
    host,
    attemptId: id,
    taskId,
    response: { choice: 0 },
    reviewedTeaching: false,
    historyEpoch: 0,
    now: new Date(),
  });

/** Requires TEST_DATABASE_URL: locks and cascades are the database's. */
describe.skipIf(!connectionString)("erasing an account", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await database
      .delete(verification)
      .where(
        inArray(verification.id, [
          `sign-in-code-sent:${adaEmail}`,
          `sign-in-code-sent:${longer}`,
          "other-code",
        ]),
      );
    await database.delete(user).where(inArray(user.email, [adaEmail, longer]));
    await database
      .delete(learnerSignInCode)
      .where(inArray(learnerSignInCode.organizationId, [fernwood, birchwood]));
    await database
      .delete(invitation)
      .where(inArray(invitation.organizationId, [fernwood, birchwood]));
    const at = new Date("2026-06-01T00:00:00.000Z");
    for (const organizationId of [fernwood, birchwood]) {
      await testing.seedOrganization(database, {
        organizationId,
        learnerIds: [ada],
        adminIds: [owner],
        at,
      });
    }
    await database.update(member).set({ role: "owner" }).where(eq(member.userId, owner));
    const [objectiveId] = await createObjectives(database, fernwood, ["Greetings"]);
    taskId = await testing.createTask(database, {
      organizationId: fernwood,
      objectiveId: objectiveId!,
      body: question("One?"),
      createdAt: new Date(Date.now() - 86_400_000),
    });
    ({ id: courseId } = await createCourse(database, {
      published: true,
      organizationId: fernwood,
      title: "Course",
      objectiveIds: [objectiveId!],
    }));
  });

  describe("what it finds", () => {
    test("every school it reaches, and the counts", async () => {
      await answer("a1");
      const { target, counts } = await find();
      expect(target).toMatchObject({ userId: ada, email: adaEmail });
      expect(target.organizations.map(({ id }) => id).sort()).toEqual([birchwood, fernwood]);
      expect(target.organizations.find(({ id }) => id === fernwood)).toMatchObject({
        slug: fernwood,
        role: "member",
        attempts: 1,
        evidence: 1,
      });
      expect(counts).toMatchObject({ attempts: 1, evidence: 1, memberships: 2 });
    });

    test("a school only an invitation or a code reaches is listed too, as its row goes", async () => {
      const later = new Date(Date.now() + 600_000);
      await database.delete(member).where(eq(member.id, `${birchwood}:${ada}`));
      await database.insert(invitation).values({
        id: `${prefix}-invited`,
        organizationId: birchwood,
        email: adaEmail,
        expiresAt: later,
        createdAt: new Date(),
        inviterId: owner,
      });
      const { target } = await find();
      expect(target.organizations.find(({ id }) => id === birchwood)).toMatchObject({
        role: null,
        attempts: 0,
      });
    });

    test("a school they left is listed for each row of theirs that goes or loses their name", async () => {
      const at = new Date();
      const later = new Date(Date.now() + 600_000);
      const oak = `${prefix}-oakwood`;
      const place = (suffix: string) => `${oak}-${suffix}`;
      const schools = ["invited", "ai", "handoff", "setting"].map(place);
      for (const organizationId of schools) {
        await testing.seedOrganization(database, { organizationId, learnerIds: [], at });
      }
      try {
        await database.insert(invitation).values({
          id: `${prefix}-sent`,
          organizationId: place("invited"),
          email: `${prefix}-someone@example.com`,
          expiresAt: later,
          createdAt: at,
          inviterId: ada,
        });
        await database.insert(aiRequest).values({
          id: `${prefix}-ai`,
          organizationId: place("ai"),
          kind: "draft",
          userId: ada,
          createdAt: at,
        });
        await database.insert(learnerHandoff).values({
          id: `${prefix}-left-handoff`,
          organizationId: place("handoff"),
          hostname: "oakwood.example",
          returnPath: "/",
          nonceHash: "nonce",
          userId: ada,
          expiresAt: later,
        });
        await database
          .update(organization)
          .set({ toolsReadLearnerDataChangedBy: ada })
          .where(eq(organization.id, place("setting")));
        const listed = (await find()).target.organizations.map(({ id }) => id);
        expect(listed).toEqual(expect.arrayContaining(schools));
      } finally {
        await database.delete(aiRequest).where(eq(aiRequest.id, `${prefix}-ai`));
        await database.delete(organization).where(inArray(organization.id, schools));
      }
    });

    test("a school whose report they dismissed is listed", async () => {
      await answer("a1");
      await database.delete(member).where(eq(member.id, `${birchwood}:${ada}`));
      const stranger = `${prefix}-stranger`;
      await testing.seedOrganization(database, {
        organizationId: birchwood,
        learnerIds: [stranger],
        adminIds: [owner],
        at: new Date("2026-06-01T00:00:00.000Z"),
      });
      const at = new Date();
      const [objectiveId] = await createObjectives(database, birchwood, ["Farewells"]);
      const birchTask = await testing.createTask(database, {
        organizationId: birchwood,
        objectiveId: objectiveId!,
        body: question("Two?"),
        createdAt: at,
      });
      await database.insert(attempt).values({
        id: "s1",
        learnerId: stranger,
        organizationId: birchwood,
        taskId: birchTask,
        response: { choice: 0 },
        at,
      });
      await database.insert(taskReport).values({
        id: `${prefix}-report`,
        learnerId: stranger,
        organizationId: birchwood,
        attemptId: "s1",
        taskId: birchTask,
        reason: "confusing",
        createdAt: at,
        dismissedAt: at,
        dismissedBy: ada,
      });
      try {
        const { target } = await find();
        expect(target.organizations.map(({ id }) => id)).toContain(birchwood);
      } finally {
        await database.delete(user).where(eq(user.id, stranger));
      }
    });

    test("with no account, the schools its rows are at are listed, and a new one refuses", async () => {
      await erase();
      const later = new Date(Date.now() + 600_000);
      const code = (organizationId: string, hostname: string) =>
        database.insert(learnerSignInCode).values({
          hostname,
          email: adaEmail,
          organizationId,
          codeSeed: "seed",
          expiresAt: later,
          resendAt: later,
        });
      await code(fernwood, "fernwood.example");
      const { target } = await find();
      expect(target.organizations.map(({ id }) => id)).toEqual([fernwood]);
      await code(birchwood, "birchwood.example");
      const log = memoryLog();
      await expect(eraseAccount({ database, target, log })).rejects.toThrow(/changed/);
      expect(log.writes).toEqual([]);
    });

    test("trims and lowercases the email, as sign-in stores it", async () => {
      const { target } = await previewAccountErasure({
        database,
        email: `  ${adaEmail.toUpperCase()} `,
      });
      expect(target.userId).toBe(ada);
    });
  });

  describe("the transaction", () => {
    test("removes rows keyed by the email, and never a longer address containing it", async () => {
      const at = new Date();
      const later = new Date(Date.now() + 600_000);
      await database.insert(learnerSignInCode).values(
        [adaEmail, longer].map((email) => ({
          hostname: "fernwood.example",
          email,
          organizationId: fernwood,
          codeSeed: "seed",
          expiresAt: later,
          resendAt: later,
        })),
      );
      await database.insert(invitation).values(
        [adaEmail, longer].map((email) => ({
          id: `${prefix}-${email}`,
          organizationId: fernwood,
          email,
          expiresAt: later,
          createdAt: at,
          inviterId: owner,
        })),
      );
      await database.insert(verification).values(
        [adaEmail, longer].map((email) => ({
          id: `sign-in-code-sent:${email}`,
          identifier: `sign-in-code-sent:${email}`,
          value: "",
          expiresAt: later,
          createdAt: at,
          updatedAt: at,
        })),
      );
      await database.insert(verification).values({
        id: "other-code",
        identifier: "other-code",
        // Someone else's code: Ada's ID inside a client's opaque `state`, and a
        // longer address, do not name Ada.
        value: JSON.stringify({
          type: "authorization_code",
          userId: owner,
          query: { state: `x${ada}y`, login_hint: longer },
        }),
        expiresAt: later,
        createdAt: at,
        updatedAt: at,
      });

      await erase();

      const left = async (table: typeof learnerSignInCode | typeof invitation) =>
        (await database.select({ email: table.email }).from(table)).map(({ email }) => email);
      expect(await left(learnerSignInCode)).toContain(longer);
      expect(await left(learnerSignInCode)).not.toContain(adaEmail);
      expect(await left(invitation)).toContain(longer);
      expect(await left(invitation)).not.toContain(adaEmail);
      const ids = (await database.select({ id: verification.id }).from(verification)).map(
        ({ id }) => id,
      );
      expect(ids).toContain(`sign-in-code-sent:${longer}`);
      expect(ids).toContain("other-code");
      expect(ids).not.toContain(`sign-in-code-sent:${adaEmail}`);
    });

    test("an address in a stored query, URL-encoded as Better Auth keeps it, in any case, is found", async () => {
      const at = new Date();
      const later = new Date(Date.now() + 600_000);
      await database.insert(verification).values({
        id: "other-code",
        identifier: "other-code",
        value: JSON.stringify({
          oauthState: "s",
          // URL-encoded, as Better Auth stores a client's query.
          serverContext: {
            query: `client_id=app&login_hint=${encodeURIComponent(adaEmail.toUpperCase())}`,
          },
        }),
        expiresAt: later,
        createdAt: at,
        updatedAt: at,
      });
      const { counts } = await find();
      expect(counts.verifications).toBe(1);
      await erase();
      expect(await database.$count(verification, eq(verification.id, "other-code"))).toBe(0);
    });

    test("never takes an organization's only owner, erasing nothing and writing no record", async () => {
      await database.update(member).set({ role: "member" }).where(eq(member.userId, owner));
      await database
        .update(member)
        .set({ role: "owner" })
        .where(eq(member.id, `${birchwood}:${ada}`));
      const log = memoryLog();
      await expect(erase(log)).rejects.toThrow(/only owner of .*birchwood/);
      expect(log.writes).toEqual([]);
      expect(await database.$count(user, eq(user.id, ada))).toBe(1);
      expect(await database.$count(member, eq(member.userId, ada))).toBe(2);
    });

    test("an owner beside another is erased, and the organization keeps the other", async () => {
      await database.update(member).set({ role: "owner" }).where(eq(member.userId, ada));
      await erase();
      expect(await database.$count(user, eq(user.id, ada))).toBe(0);
      expect(await database.$count(member, eq(member.organizationId, fernwood))).toBe(1);
    });

    test("two owners erased at once leave one, whichever goes first", async () => {
      await database.update(member).set({ role: "owner" }).where(eq(member.userId, ada));
      let blocked: Promise<void> | undefined;
      let writes = 0;
      const slow = {
        hmacKey: secret,
        store: {
          // Holding its turn until the other waits for it: unserialized, both would
          // pass their owner check, and neither ever wait.
          put: () => {
            writes += 1;
            return (blocked ??= waitForLock("%for update%"));
          },
        },
      };
      const results = await Promise.allSettled(
        [adaEmail, `${owner}@example.com`].map(async (email) => {
          const { target } = await previewAccountErasure({ database, email });
          return eraseAccount({ database, target, log: slow });
        }),
      );
      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      // Refused before its intent: only the winner's record, written and marked.
      expect(writes).toBe(2);
      for (const organizationId of [fernwood, birchwood]) {
        expect(
          await database.$count(
            member,
            and(eq(member.organizationId, organizationId), eq(member.role, "owner")),
          ),
        ).toBe(1);
      }
    });

    test("a school joined since the confirmation refuses, nothing erased: it was never shown", async () => {
      const { target } = await find();
      const elsewhere = `${prefix}-oakwood`;
      await testing.seedOrganization(database, {
        organizationId: elsewhere,
        learnerIds: [ada],
        at: new Date(),
      });
      try {
        const log = memoryLog();
        await expect(eraseAccount({ database, target, log })).rejects.toThrow(/changed/);
        expect(log.writes).toEqual([]);
        expect(await database.$count(user, eq(user.id, ada))).toBe(1);
      } finally {
        await database.delete(organization).where(eq(organization.id, elsewhere));
      }
    });

    test("an account gone or renamed since the confirmation refuses, writing nothing", async () => {
      const { target } = await find();
      const log = memoryLog();
      await expect(
        eraseAccount({ database, target: { ...target, email: longer }, log }),
      ).rejects.toThrow(/changed/);
      await expect(
        eraseAccount({ database, target: { ...target, userId: "nobody" }, log }),
      ).rejects.toThrow(/changed/);
      expect(log.writes).toEqual([]);
    });
  });

  describe("other writers", () => {
    test("an attempt in flight lands before it and is erased", async () => {
      let erasing!: Promise<unknown>;
      const { target } = await find();
      await withLearnerHistoryLock(
        database,
        { learnerId: ada, organizationId: fernwood },
        async (transaction) => {
          await transaction.insert(attempt).values({
            id: "in-flight",
            learnerId: ada,
            organizationId: fernwood,
            taskId,
            response: { choice: 0 },
            at: new Date(),
          });
          erasing = eraseAccount({ database, target, log: memoryLog() });
          await untilWaitingForLearner();
        },
      );
      await erasing;
      expect(await database.$count(attempt, eq(attempt.learnerId, ada))).toBe(0);
    });

    // Each locks its row, then references the account: the erasure must not
    // hold the account while wanting that row, which PostgreSQL would break by
    // aborting one of them.
    test("a sign-in code being spent finishes first, and its session goes with the account", async () => {
      const later = new Date(Date.now() + 600_000);
      await database.insert(learnerSignInCode).values({
        hostname: "fernwood.example",
        email: adaEmail,
        organizationId: fernwood,
        codeSeed: "seed",
        expiresAt: later,
        resendAt: later,
      });
      const { target } = await find();
      let erasing!: Promise<unknown>;
      await database.transaction(async (transaction) => {
        await transaction
          .select()
          .from(learnerSignInCode)
          .where(eq(learnerSignInCode.email, adaEmail))
          .for("update");
        erasing = eraseAccount({ database, target, log: memoryLog() });
        await waitForLock("%learner_sign_in_code%for update%");
        await transaction.insert(learnerSession).values({
          tokenHash: `${prefix}-spent`,
          userId: ada,
          organizationId: fernwood,
          hostname: "fernwood.example",
          expiresAt: later,
        });
      });
      await erasing;
      expect(await database.$count(learnerSession, eq(learnerSession.userId, ada))).toBe(0);
    });

    test("a handoff being redeemed finishes first, and its session goes with the account", async () => {
      const later = new Date(Date.now() + 600_000);
      const id = `${prefix}-handoff`;
      await database.insert(learnerHandoff).values({
        id,
        organizationId: fernwood,
        hostname: "fernwood.example",
        returnPath: "/",
        nonceHash: "nonce",
        userId: ada,
        expiresAt: later,
      });
      const { target } = await find();
      let erasing!: Promise<unknown>;
      await database.transaction(async (transaction) => {
        await transaction.delete(learnerHandoff).where(eq(learnerHandoff.id, id));
        erasing = eraseAccount({ database, target, log: memoryLog() });
        await waitForLock("%learner_handoff%for update%");
        await transaction.insert(learnerSession).values({
          tokenHash: `${prefix}-redeemed`,
          userId: ada,
          organizationId: fernwood,
          hostname: "fernwood.example",
          expiresAt: later,
        });
      });
      await erasing;
      expect(await database.$count(learnerSession, eq(learnerSession.userId, ada))).toBe(0);
    });

    test("an attempt during it records nothing", async () => {
      let submitted!: Promise<unknown>;
      await erase(
        memoryLog(async () => {
          submitted = answer("racing").catch((error: unknown) => error);
          await untilWaitingForLearner();
        }),
      );
      const outcome = await submitted;
      expect(outcome).not.toMatchObject({ kind: "graded" });
      expect(await database.$count(attempt, eq(attempt.learnerId, ada))).toBe(0);
      expect(await database.$count(learnerEvidence, eq(learnerEvidence.learnerId, ada))).toBe(0);
    });

    const pendingCode = {
      id: `${prefix}-device`,
      deviceCode: `${prefix}-device-code`,
      userCode: `${prefix}-user-code`,
      expiresAt: new Date(Date.now() + 600_000),
      status: "pending",
    };
    /** As Better Auth's device approval claims a code, naming who approved it. */
    const approve = () =>
      database
        .update(deviceCode)
        .set({ userId: ada, status: "approved" })
        .where(eq(deviceCode.id, pendingCode.id));

    test("a device approval during it fails on the foreign key, leaving no row with the ID", async () => {
      await database.delete(deviceCode).where(eq(deviceCode.id, pendingCode.id));
      await database.insert(deviceCode).values(pendingCode);
      let approving!: Promise<unknown>;
      await erase(
        memoryLog(async () => {
          approving = approve().then(
            () => "approved",
            (error: unknown) => error,
          );
          // Held by the account's row until the erasure commits.
          await waitForLock('%update "device_code"%');
        }),
      );
      expect(await approving).toBeInstanceOf(Error);
      const [row] = await database
        .select({ userId: deviceCode.userId, status: deviceCode.status })
        .from(deviceCode)
        .where(eq(deviceCode.id, pendingCode.id));
      expect(row).toEqual({ userId: null, status: "pending" });
      await database.delete(deviceCode).where(eq(deviceCode.id, pendingCode.id));
    });

    test("a device approval after it fails the same way", async () => {
      await database.delete(deviceCode).where(eq(deviceCode.id, pendingCode.id));
      await database.insert(deviceCode).values(pendingCode);
      await erase();
      await expect(approve()).rejects.toThrow();
      await database.delete(deviceCode).where(eq(deviceCode.id, pendingCode.id));
    });

    test("a device approval before it goes with the account", async () => {
      await database.delete(deviceCode).where(eq(deviceCode.id, pendingCode.id));
      await database.insert(deviceCode).values(pendingCode);
      await approve();
      await erase();
      expect(await database.$count(deviceCode, eq(deviceCode.id, pendingCode.id))).toBe(0);
    });
  });

  describe("the log", () => {
    test("holds the intent before anything is deleted, done only after commit", async () => {
      let during: number | undefined;
      const log = memoryLog(async () => {
        during = await database.$count(user, eq(user.id, ada));
      });
      const { recordId } = await erase(log);
      expect(during).toBe(1);
      expect(log.writes).toHaveLength(2);
      expect(log.writes[0]).toMatchObject({
        format: "braivo-erasure-log",
        version: 1,
        id: recordId,
        scope: "account",
        userId: ada,
        email: {
          hmac: createHmac("sha256", secret).update(adaEmail).digest("hex"),
          rule: "trim-lowercase-v1",
        },
        doneAt: null,
      });
      expect(log.writes[1]?.doneAt).toEqual(expect.any(String));
      expect(JSON.stringify(log.writes)).not.toContain(adaEmail);
    });

    test("its marker is in the database with the erasure", async () => {
      const { recordId } = await erase();
      expect(await database.$count(accountErasure, eq(accountErasure.id, recordId))).toBe(1);
    });

    test("no intent, no erasure: a store that fails erases nothing", async () => {
      const { target } = await find();
      const log = {
        hmacKey: secret,
        store: {
          put: async () => {
            throw new Error("store unavailable");
          },
        },
      };
      await expect(eraseAccount({ database, target, log })).rejects.toThrow(/store unavailable/);
      expect(await database.$count(user, eq(user.id, ada))).toBe(1);
    });

    test("failing after its intent rolls everything back, and names the pending record", async () => {
      const later = new Date(Date.now() + 600_000);
      await database.insert(learnerSignInCode).values({
        hostname: "fernwood.example",
        email: adaEmail,
        organizationId: fernwood,
        codeSeed: "seed",
        expiresAt: later,
        resendAt: later,
      });
      const { target } = await find();
      // The marker comes last, so a taken ID fails it with everything else deleted.
      const log = memoryLog(async () => {
        await database.insert(accountErasure).values({ id: log.writes[0]!.id });
      });
      await expect(eraseAccount({ database, target, log })).rejects.toThrow(
        /Log record .* is pending/,
      );
      expect(log.writes).toHaveLength(1);
      expect(await database.$count(user, eq(user.id, ada))).toBe(1);
      expect(await database.$count(member, eq(member.userId, ada))).toBe(2);
      expect(await database.$count(learnerSignInCode, eq(learnerSignInCode.email, adaEmail))).toBe(
        1,
      );
    });

    test("committed with its entry left pending, it says so rather than done", async () => {
      const { target } = await find();
      let writes = 0;
      const log = {
        hmacKey: secret,
        store: {
          put: async () => {
            writes += 1;
            if (writes === 2) throw new Error("store unavailable");
          },
        },
      };
      await expect(eraseAccount({ database, target, log })).rejects.toThrow(
        /account was erased, but log record/,
      );
      expect(await database.$count(user, eq(user.id, ada))).toBe(0);
    });
  });

  describe("with no account", () => {
    test("rows naming the address are removed, under a record of no user", async () => {
      await erase();
      const later = new Date(Date.now() + 600_000);
      await database.insert(learnerSignInCode).values({
        hostname: "fernwood.example",
        email: adaEmail,
        organizationId: fernwood,
        codeSeed: "seed",
        expiresAt: later,
        resendAt: later,
      });
      const { target, counts } = await find();
      expect(counts.signInCodes).toBe(1);
      const log = memoryLog();
      await eraseAccount({ database, target, log });
      expect(await database.$count(learnerSignInCode, eq(learnerSignInCode.email, adaEmail))).toBe(
        0,
      );
      expect(log.writes[0]).toMatchObject({ scope: "account", userId: null });
    });

    test("an account made since the confirmation refuses", async () => {
      await erase();
      const { target } = await find();
      await database.insert(user).values({
        id: ada,
        name: ada,
        email: adaEmail,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(eraseAccount({ database, target, log: memoryLog() })).rejects.toThrow(/changed/);
      expect(await database.$count(user, eq(user.id, ada))).toBe(1);
    });
  });
});
