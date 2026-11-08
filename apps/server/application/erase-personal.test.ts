// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, runMigrations } from "@braivo/db";
import {
  accountErasure,
  aiRequest,
  attempt,
  course,
  file,
  learnerEvidence,
  learnerSignInCode,
  member,
  objective,
  organization,
  source,
  task,
  user,
} from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { createCourse, createObjectives, createSource } from "../persistence/index.ts";
import { directoryStore, durableDirectoryStore, type FileStore } from "../storage/index.ts";
import { submitAttempt } from "./activity.ts";
import {
  eraseAccount,
  type PendingErasureOutcome,
  previewAccountErasure,
  resolvePendingErasures,
} from "./erase-account.ts";
import type { ErasureRecord, ReadableErasureLog } from "./erasure-log.ts";
import { uploadFile } from "./files.ts";
import { setUpPersonalOrganization } from "./organizations.ts";
import { NotPermitted } from "./permission.ts";

// An account's erasure reaching its personal organization (ADR 0060, access-49):
// its rows in the commit, its files' bytes after, uploads and erasures in one
// lock order, and a pending record resolved by its own IDs on the next run.

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const secret = "erasure-log-test-key-that-is-long-enough";
const at = new Date("2026-06-01T00:00:00.000Z");
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);

/** A fresh account, its email unique to it unless given. */
async function person(email?: string) {
  const id = `erase-personal-${crypto.randomUUID()}`;
  const address = email ?? `${id}@example.com`;
  await database.insert(user).values({
    id,
    name: "Ada Fernley",
    email: address,
    emailVerified: true,
    createdAt: at,
    updatedAt: at,
  });
  return { id, email: address };
}

async function personalOf(userId: string) {
  return (await setUpPersonalOrganization({ database, actingAs: userId, now: at })).organization;
}

/** The erasure log in a directory, as the operator keeps it; `onIntent` runs once each intent is written. */
async function directoryLog(onIntent?: (record: ErasureRecord) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "erase-personal-log-"));
  const durable = durableDirectoryStore(directory);
  const log: ReadableErasureLog = {
    hmacKey: secret,
    store: {
      ...durable,
      async put(key, bytes, type) {
        await durable.put(key, bytes, type);
        const record = JSON.parse(new TextDecoder().decode(bytes)) as ErasureRecord;
        if (record.doneAt === null && record.supersededBy === null) await onIntent?.(record);
      },
    },
  };
  const read = async (id: string) =>
    JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")) as ErasureRecord;
  return { log, read };
}

async function fileStore() {
  return directoryStore(await mkdtemp(join(tmpdir(), "erase-personal-files-")));
}

const objectsOf = (files: FileStore, organizationId: string) =>
  files.list(`organizations/${organizationId}`);

function upload(files: FileStore, organizationId: string, actingAs: string, text: string) {
  return uploadFile({
    database,
    files,
    organizationId,
    actingAs,
    bytes: pdf(text),
    contentType: "application/pdf",
    now: new Date(),
  });
}

async function erase(email: string, log: ReadableErasureLog, files: FileStore | undefined) {
  const { target } = await previewAccountErasure({ database, email });
  return eraseAccount({ database, target, log, files });
}

const resolve = (email: string, log: ReadableErasureLog, files: FileStore, timeoutMs = 10_000) =>
  resolvePendingErasures({ database, log, files, email, timeoutMs });

/** Until a statement like `pattern` (SQL `like`) waits for another transaction's lock. */
async function waitForLock(pattern: string): Promise<void> {
  for (let tries = 0; tries < 250; tries++) {
    const waiting = await database.execute(
      sql`select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like ${pattern}`,
      "objects",
    );
    if (waiting.length > 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`No statement like ${pattern} waited for a lock.`);
}

/** A promise and the function settling it, for holding a writer in place. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const rowsOf = async (organizationId: string) => ({
  organization: await database.$count(organization, eq(organization.id, organizationId)),
  members: await database.$count(member, eq(member.organizationId, organizationId)),
  courses: await database.$count(course, eq(course.organizationId, organizationId)),
  objectives: await database.$count(objective, eq(objective.organizationId, organizationId)),
  tasks: await database.$count(task, eq(task.organizationId, organizationId)),
  sources: await database.$count(source, eq(source.organizationId, organizationId)),
  files: await database.$count(file, eq(file.organizationId, organizationId)),
  attempts: await database.$count(attempt, eq(attempt.organizationId, organizationId)),
  evidence: await database.$count(
    learnerEvidence,
    eq(learnerEvidence.organizationId, organizationId),
  ),
  aiRequests: await database.$count(aiRequest, eq(aiRequest.organizationId, organizationId)),
});
const none = {
  organization: 0,
  members: 0,
  courses: 0,
  objectives: 0,
  tasks: 0,
  sources: 0,
  files: 0,
  attempts: 0,
  evidence: 0,
  aiRequests: 0,
};

const outcomesOf = (resolved: PendingErasureOutcome[]) =>
  resolved.map(({ record, outcome }) => ({ recordId: record.id, outcome }));

describe.skipIf(!connectionString)("erasing an account with its personal organization", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  test("leaves no row or object of it, the record done and naming it (1)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    const original = await upload(files, own.id, ada.id, "Greek");
    await createSource(database, {
      organizationId: own.id,
      title: "Greek",
      text: "Γεια σου.",
      original: original.sha256,
      createdAt: at,
    });
    const [objectiveId] = await createObjectives(database, own.id, ["Greetings"]);
    const taskId = await testing.createTask(database, {
      organizationId: own.id,
      objectiveId: objectiveId!,
      body: { kind: "choice", prompt: "Hello?", options: ["Γεια", "Αντίο"], answer: 0 },
      createdAt: new Date(Date.now() - 86_400_000),
    });
    const { id: courseId } = await createCourse(database, {
      published: true,
      organizationId: own.id,
      title: "Greek",
      objectiveIds: [objectiveId!],
    });
    await submitAttempt({
      database,
      learnerId: ada.id,
      courseId,
      host: { hostname: "localhost", installation: true },
      attemptId: crypto.randomUUID(),
      taskId,
      response: { choice: 0 },
      reviewedTeaching: false,
      historyEpoch: 0,
      now: new Date(),
    });
    await database.insert(aiRequest).values({
      id: crypto.randomUUID(),
      organizationId: own.id,
      kind: "draft",
      userId: ada.id,
      createdAt: at,
    });
    expect(await rowsOf(own.id)).toMatchObject({
      attempts: 1,
      evidence: 1,
      files: 1,
      aiRequests: 1,
    });
    expect(await objectsOf(files, own.id)).toHaveLength(1);

    const { log, read } = await directoryLog();
    const { target } = await previewAccountErasure({ database, email: ada.email });
    expect(target.personal).toEqual({
      id: own.id,
      slug: own.slug,
      courses: 1,
      objectives: 1,
      tasks: 1,
      sources: 1,
      files: 1,
      aiRequests: 1,
    });
    const { recordId, personal } = await eraseAccount({ database, target, log, files });

    expect(personal?.id).toBe(own.id);
    expect(await rowsOf(own.id)).toEqual(none);
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(0);
    expect(await objectsOf(files, own.id)).toEqual([]);
    expect(await read(recordId)).toMatchObject({
      scope: "account",
      userId: ada.id,
      personalOrganizationId: own.id,
      doneAt: expect.any(String),
      supersededBy: null,
    });
  });

  test("takes the locks in one order, writing its intent while the account's row is held", async () => {
    const ada = await person();
    await personalOf(ada.id);
    const statements: string[] = [];
    const recording = testing.recordingDatabase(connectionString ?? "", statements);
    try {
      const { log } = await directoryLog(async () => void statements.push("-- intent written"));
      const { target } = await previewAccountErasure({ database: recording, email: ada.email });
      statements.length = 0;
      await eraseAccount({ database: recording, target, log, files: await fileStore() });
    } finally {
      await recording.$client.end();
    }
    const at = (pattern: RegExp) => {
      const index = statements.findIndex((statement) => pattern.test(statement));
      expect(index, String(pattern)).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(/pg_advisory_xact_lock/),
      at(/from "learner_sign_in_code".*for update/s),
      at(/from "learner_handoff".*for update/s),
      at(/from "organization".*"personal_owner_id".*for update/s),
      at(/from "user".*for update/s),
      at(/^-- intent written$/),
      at(/^delete from "objective_citation"/),
      at(/^delete from "organization"/),
      at(/^delete from "user"/),
    ];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("waits for an upload holding its organization, then erases what it recorded (2)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    const writing = gate();
    const entered = gate();
    const held: FileStore = {
      ...files,
      async put(key, bytes, type) {
        entered.open();
        await writing.opened;
        await files.put(key, bytes, type);
      },
    };
    const uploading = upload(held, own.id, ada.id, "late");
    await entered.opened;

    const { log } = await directoryLog();
    const erasing = erase(ada.email, log, files);
    await waitForLock(`%from "organization"%for update%`);
    writing.open();
    expect((await uploading).sha256).toMatch(/^[0-9a-f]{64}$/);
    await erasing;

    expect(await rowsOf(own.id)).toEqual(none);
    expect(await objectsOf(files, own.id)).toEqual([]);
  });

  test("holds an upload arriving meanwhile, then refuses it, an overwrite too, writing nothing (3)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "kept");
    const deleting = gate();
    const locked = gate();
    const { log } = await directoryLog(async () => {
      locked.open();
      await deleting.opened;
    });
    const erasing = erase(ada.email, log, files);
    // Its intent written: every lock taken, nothing deleted yet.
    await locked.opened;

    let puts = 0;
    const counted: FileStore = { ...files, put: async (...args) => (puts++, files.put(...args)) };
    // The same bytes again, its `file` row already there: no deadlock with the erasure's delete.
    const uploading = upload(counted, own.id, ada.id, "kept").catch((error: unknown) => error);
    await waitForLock(`%from "organization"%for key share%`);
    deleting.open();
    await erasing;

    expect(await uploading).toBeInstanceOf(NotPermitted);
    expect(puts).toBe(0);
    expect(await rowsOf(own.id)).toEqual(none);
    expect(await objectsOf(files, own.id)).toEqual([]);
  });

  test("an upload whose connection is lost mid-write, its lock gone, removes bytes stored after the erasure", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    const writing = gate();
    const entered = gate();
    const held: FileStore = {
      ...files,
      async put(key, bytes, type) {
        entered.open();
        await writing.opened;
        await files.put(key, bytes, type);
        // Stored, though the upload never hears so.
        throw new Error("The store's answer was lost.");
      },
    };
    // A pool of its own, named, so only the upload's connection is cut, never another test's.
    const name = `erase-personal-upload-${crypto.randomUUID()}`;
    const url = new URL(connectionString ?? "");
    url.searchParams.set("application_name", name);
    const uploaderDatabase = createDatabase(url.href);
    try {
      const uploading = uploadFile({
        database: uploaderDatabase,
        files: held,
        organizationId: own.id,
        actingAs: ada.id,
        bytes: pdf("late"),
        contentType: "application/pdf",
        now: new Date(),
      }).catch((error: unknown) => error);
      await entered.opened;
      // Its connection lost, the organization's lock with it: the erasure no longer waits.
      const [{ terminated } = { terminated: 0 }] = await database.execute<{ terminated: number }>(
        sql`select count(pg_terminate_backend(pid))::int as terminated from pg_stat_activity
          where datname = current_database() and application_name = ${name}`,
        "objects",
      );
      expect(terminated).toBe(1);
      const { log, read } = await directoryLog();
      const { recordId } = await erase(ada.email, log, files);
      expect((await read(recordId)).doneAt).toEqual(expect.any(String));

      // The store's write lands after the erasure emptied the prefix.
      writing.open();
      expect(await uploading).toBeInstanceOf(Error);
      expect(await rowsOf(own.id)).toEqual(none);
      expect(await objectsOf(files, own.id)).toEqual([]);
    } finally {
      // Never left holding the upload, whatever failed above.
      writing.open();
      await uploaderDatabase.$client.end();
    }
  });

  test("a store failing after commit leaves the record pending, and the next run finishes it (4)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "bytes");
    const failing: FileStore = {
      ...files,
      deletePrefix: async () => {
        throw new Error("store unavailable");
      },
    };
    const { log, read } = await directoryLog();

    const refused = await erase(ada.email, log, failing).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    const [, recordId] = /Log record (\S+) is pending; run this command again/.exec(
      (refused as Error).message,
    )!;
    expect(await rowsOf(own.id)).toEqual(none);
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(0);
    expect(await objectsOf(files, own.id)).toHaveLength(1);
    expect(await read(recordId!)).toMatchObject({ doneAt: null, supersededBy: null });

    expect(outcomesOf(await resolve(ada.email, log, files))).toEqual([
      { recordId, outcome: "done" },
    ]);
    expect(await objectsOf(files, own.id)).toEqual([]);
    expect((await read(recordId!)).doneAt).toEqual(expect.any(String));
    // Done, it is not found again.
    expect(await resolve(ada.email, log, files)).toEqual([]);
  });

  test("a transaction failing before commit deletes no bytes; the next erasure that commits closes it (5)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "bytes");
    let first: ErasureRecord | undefined;
    const { log, read } = await directoryLog(async (record) => {
      if (first) return;
      first = record;
      throw new Error("the database went away");
    });

    await expect(erase(ada.email, log, files)).rejects.toThrow("the database went away");
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(1);
    expect((await rowsOf(own.id)).files).toBe(1);
    expect(await objectsOf(files, own.id)).toHaveLength(1);

    const resolved = await resolve(ada.email, log, files);
    expect(outcomesOf(resolved)).toEqual([{ recordId: first!.id, outcome: "not committed" }]);
    // Kept, as a restored database would say the same of one that committed.
    expect(await read(first!.id)).toMatchObject({ doneAt: null, supersededBy: null });
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(1);
    expect(outcomesOf(await resolve(ada.email, log, files))).toEqual(outcomesOf(resolved));

    // Erased now, under a record of its own, which then closes the first.
    const { target } = await previewAccountErasure({ database, email: ada.email });
    const { recordId } = await eraseAccount({ database, target, log, files, resolved });
    expect(recordId).not.toBe(first!.id);
    expect(await read(first!.id)).toMatchObject({ doneAt: null, supersededBy: recordId });
    expect(await objectsOf(files, own.id)).toEqual([]);
    expect(await resolve(ada.email, log, files)).toEqual([]);
  });

  test("after a restore lacking its marker, a committed one stays pending until erased again", async () => {
    const ada = await person();
    await personalOf(ada.id);
    const { log: directory, read } = await directoryLog();
    // Committed, its mark of done lost.
    const log: ReadableErasureLog = {
      ...directory,
      store: {
        ...directory.store,
        async put(key, bytes, type) {
          const record = JSON.parse(new TextDecoder().decode(bytes)) as ErasureRecord;
          if (record.doneAt !== null) throw new Error("log unavailable");
          await directory.store.put(key, bytes, type);
        },
      },
    };
    const refused = (await erase(ada.email, log, await fileStore()).catch(
      (e: Error) => e,
    )) as Error;
    const [, recordId] = /log record (\S+) could not be marked done/.exec(refused.message)!;
    // A backup from before it, restored: the account back, the marker not.
    await database.insert(user).values({
      id: ada.id,
      name: "Ada Fernley",
      email: ada.email,
      emailVerified: true,
      createdAt: at,
      updatedAt: at,
    });
    await database.delete(accountErasure).where(eq(accountErasure.id, recordId!));

    const files = await fileStore();
    const resolved = await resolve(ada.email, directory, files);
    expect(outcomesOf(resolved)).toEqual([{ recordId, outcome: "not committed" }]);
    // Declined, or the run stopping here: the instruction is still there.
    expect(await read(recordId!)).toMatchObject({ doneAt: null, supersededBy: null });
    const { target } = await previewAccountErasure({ database, email: ada.email });
    const again = await eraseAccount({ database, target, log: directory, files, resolved });
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(0);
    expect(await read(recordId!)).toMatchObject({ supersededBy: again.recordId });
  });

  test("never erases a personal organization without its files' store, nor finishes one", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "bytes");
    const { log, read } = await directoryLog();

    await expect(erase(ada.email, log, undefined)).rejects.toThrow(
      `BRAIVO_FILES must be set, as serve has it, to delete the files of personal organization ${own.id}. Nothing was erased.`,
    );
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(1);
    expect(await log.store.list("")).toEqual([]);

    // Left pending by a failing store, it is not finished without one either.
    const failing: FileStore = {
      ...files,
      deletePrefix: async () => {
        throw new Error("store unavailable");
      },
    };
    const refused = (await erase(ada.email, log, failing).catch((e: Error) => e)) as Error;
    const [, recordId] = /Log record (\S+) is pending/.exec(refused.message)!;
    await expect(
      resolvePendingErasures({
        database,
        log,
        files: undefined,
        email: ada.email,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(`Log record ${recordId} is still pending`);
    expect(await read(recordId!)).toMatchObject({ doneAt: null, supersededBy: null });
    expect(await objectsOf(files, own.id)).toHaveLength(1);
    // Nor one with no file recorded: bytes an upload stored before failing have no row.
    const bea = await person();
    const beas = await personalOf(bea.id);
    const failingUpload: FileStore = {
      ...files,
      async put(key, bytes, type) {
        await files.put(key, bytes, type);
        throw new Error("lost the answer");
      },
    };
    await expect(upload(failingUpload, beas.id, bea.id, "orphan")).rejects.toThrow(
      "lost the answer",
    );
    expect((await rowsOf(beas.id)).files).toBe(0);
    await expect(erase(bea.email, log, undefined)).rejects.toThrow("BRAIVO_FILES must be set");
    expect(await database.$count(user, eq(user.id, bea.id))).toBe(1);
    await erase(bea.email, log, files);
    expect(await objectsOf(files, beas.id)).toEqual([]);
  });

  test("superseding a record empties the personal organization it named, though the account's is gone", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "bytes");
    const { log, read } = await directoryLog();
    const failing: FileStore = {
      ...files,
      deletePrefix: async () => {
        throw new Error("store unavailable");
      },
    };
    const refused = (await erase(ada.email, log, failing).catch((e: Error) => e)) as Error;
    const [, recordId] = /Log record (\S+) is pending/.exec(refused.message)!;
    // A backup from before the personal organization, restored: the account alone, no marker.
    await database.insert(user).values({
      id: ada.id,
      name: "Ada Fernley",
      email: ada.email,
      emailVerified: true,
      createdAt: at,
      updatedAt: at,
    });
    await database.delete(accountErasure).where(eq(accountErasure.id, recordId!));

    const resolved = await resolve(ada.email, log, files);
    expect(outcomesOf(resolved)).toEqual([{ recordId, outcome: "not committed" }]);
    const { target } = await previewAccountErasure({ database, email: ada.email });
    expect(target.personal).toBeNull();
    await expect(
      eraseAccount({ database, target, log, files: undefined, resolved }),
    ).rejects.toThrow(
      `BRAIVO_FILES must be set, as serve has it, to delete the files of personal organization ${own.id}. Nothing was erased.`,
    );
    const again = await eraseAccount({ database, target, log, files, resolved });
    expect(await objectsOf(files, own.id)).toEqual([]);
    expect(await read(recordId!)).toMatchObject({ supersededBy: again.recordId });
  });

  test("a superseded record that cannot be closed says the account was erased, and stays pending", async () => {
    const ada = await person();
    await personalOf(ada.id);
    const files = await fileStore();
    let first: ErasureRecord | undefined;
    const { log: directory, read } = await directoryLog(async (record) => {
      if (first) return;
      first = record;
      throw new Error("the database went away");
    });
    await expect(erase(ada.email, directory, files)).rejects.toThrow("the database went away");
    const resolved = await resolve(ada.email, directory, files);
    const log: ReadableErasureLog = {
      ...directory,
      store: {
        ...directory.store,
        async put(key, bytes, type) {
          const record = JSON.parse(new TextDecoder().decode(bytes)) as ErasureRecord;
          if (record.supersededBy !== null) throw new Error("log unavailable");
          await directory.store.put(key, bytes, type);
        },
      },
    };
    const { target } = await previewAccountErasure({ database, email: ada.email });
    const failed = (await eraseAccount({ database, target, log, files, resolved }).catch(
      (e: Error) => e,
    )) as Error;
    expect(failed.message).toMatch(
      new RegExp(
        `^The account was erased under log record \\S+, done, but earlier log record ${first!.id} could not be closed: log unavailable\nIt stays pending, for the replay; note both IDs in the request's register entry\\.$`,
      ),
    );
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(0);
    expect(await read(first!.id)).toMatchObject({ doneAt: null, supersededBy: null });
  });

  describe("a second run while the first holds the account, its intent written (6)", () => {
    async function paused() {
      const ada = await person();
      const own = await personalOf(ada.id);
      const files = await fileStore();
      await upload(files, own.id, ada.id, "bytes");
      const going = gate();
      let rollBack = false;
      let intent: ErasureRecord | undefined;
      const { log, read } = await directoryLog(async (record) => {
        intent = record;
        await going.opened;
        if (rollBack) throw new Error("rolled back");
      });
      const erasing = erase(ada.email, log, files).catch((error: unknown) => error);
      for (let tries = 0; !intent && tries < 250; tries++) await Bun.sleep(20);
      return {
        ada,
        own,
        files,
        log,
        read,
        erasing,
        recordId: intent!.id,
        go: (asRollBack = false) => ((rollBack = asRollBack), going.open()),
      };
    }

    test("waits, and judges it committed by its marker", async () => {
      const first = await paused();
      const resolving = resolve(first.ada.email, first.log, first.files);
      await waitForLock(`%from "user"%for update%`);
      first.go();
      expect(outcomesOf(await resolving)).toEqual([{ recordId: first.recordId, outcome: "done" }]);
      expect(await first.erasing).toMatchObject({ recordId: first.recordId });
      expect(await objectsOf(first.files, first.own.id)).toEqual([]);
    });

    test("waits, and finds it not committed when it rolled back, keeping it", async () => {
      const first = await paused();
      const resolving = resolve(first.ada.email, first.log, first.files);
      await waitForLock(`%from "user"%for update%`);
      first.go(true);
      expect(outcomesOf(await resolving)).toEqual([
        { recordId: first.recordId, outcome: "not committed" },
      ]);
      expect(await first.erasing).toBeInstanceOf(Error);
      expect(await first.read(first.recordId)).toMatchObject({ doneAt: null, supersededBy: null });
      expect(await database.$count(user, eq(user.id, first.ada.id))).toBe(1);
      expect(await objectsOf(first.files, first.own.id)).toHaveLength(1);
    });

    test("past its deadline, reports it held and changes nothing", async () => {
      const first = await paused();
      expect(outcomesOf(await resolve(first.ada.email, first.log, first.files, 200))).toEqual([
        { recordId: first.recordId, outcome: "held" },
      ]);
      expect(await first.read(first.recordId)).toMatchObject({
        doneAt: null,
        supersededBy: null,
      });
      expect(await objectsOf(first.files, first.own.id)).toHaveLength(1);
      first.go();
      await first.erasing;
    });
  });

  test("a later account under the email is not the record's: its files stay, for a fresh erasure (7)", async () => {
    const email = `erase-personal-${crypto.randomUUID()}@example.com`;
    const ada = await person(email);
    const own = await personalOf(ada.id);
    const files = await fileStore();
    await upload(files, own.id, ada.id, "first");
    const { log, read } = await directoryLog();
    const failing: FileStore = {
      ...files,
      deletePrefix: async () => {
        throw new Error("store unavailable");
      },
    };
    const refused = (await erase(email, log, failing).catch((error: Error) => error)) as Error;
    const [, recordId] = /Log record (\S+) is pending/.exec(refused.message)!;

    // The address registers again: another account, with its own.
    const again = await person(email);
    const theirs = await personalOf(again.id);
    await upload(files, theirs.id, again.id, "second");

    expect(outcomesOf(await resolve(email, log, files))).toEqual([{ recordId, outcome: "done" }]);
    expect((await read(recordId!)).doneAt).toEqual(expect.any(String));
    expect(await objectsOf(files, own.id)).toEqual([]);
    // Untouched, and what the command shows next, to confirm afresh.
    expect(await objectsOf(files, theirs.id)).toHaveLength(1);
    expect(await database.$count(user, eq(user.id, again.id))).toBe(1);
    const { target } = await previewAccountErasure({ database, email });
    expect(target).toMatchObject({ userId: again.id, personal: { id: theirs.id } });
  });

  test("an erasure with no account, still running, is left pending, then done once its marker is there (8)", async () => {
    const email = `erase-personal-${crypto.randomUUID()}@example.com`;
    const school = `erase-personal-school-${crypto.randomUUID()}`;
    await testing.seedOrganization(database, { organizationId: school, learnerIds: [], at });
    const later = new Date(Date.now() + 600_000);
    await database.insert(learnerSignInCode).values({
      hostname: "fernwood.example",
      email,
      organizationId: school,
      codeSeed: "seed",
      expiresAt: later,
      resendAt: later,
    });
    const files = await fileStore();
    const going = gate();
    let intent: ErasureRecord | undefined;
    const { log: directory, read } = await directoryLog(async (record) => {
      intent = record;
      await going.opened;
    });
    // Its own mark of done lost, as a crash after commit would: only the marker says it committed.
    const log: ReadableErasureLog = {
      ...directory,
      store: {
        ...directory.store,
        async put(key, bytes, type) {
          const record = JSON.parse(new TextDecoder().decode(bytes)) as ErasureRecord;
          if (record.doneAt !== null && record.id === intent?.id && !lost) {
            lost = true;
            throw new Error("log unavailable");
          }
          await directory.store.put(key, bytes, type);
        },
      },
    };
    let lost = false;
    const { target } = await previewAccountErasure({ database, email });
    expect(target.userId).toBeNull();
    const erasing = eraseAccount({ database, target, log, files }).catch((error: Error) => error);
    for (let tries = 0; !intent && tries < 250; tries++) await Bun.sleep(20);

    // Its transaction holds no row to wait on, so no marker yet says nothing: left pending.
    expect(outcomesOf(await resolve(email, log, files))).toEqual([
      { recordId: intent!.id, outcome: "undetermined" },
    ]);
    expect(await read(intent!.id)).toMatchObject({ doneAt: null, supersededBy: null });

    going.open();
    expect(((await erasing) as Error).message).toContain("could not be marked done");
    expect(await database.$count(accountErasure, eq(accountErasure.id, intent!.id))).toBe(1);
    expect(outcomesOf(await resolve(email, log, files))).toEqual([
      { recordId: intent!.id, outcome: "done" },
    ]);
    expect((await read(intent!.id)).doneAt).toEqual(expect.any(String));
  });

  test("still refuses a school's only owner, erasing nothing, their own included (9)", async () => {
    const ada = await person();
    const own = await personalOf(ada.id);
    const school = `erase-personal-school-${crypto.randomUUID()}`;
    await testing.seedOrganization(database, { organizationId: school, learnerIds: [], at });
    await database.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: school,
      userId: ada.id,
      role: "owner",
      createdAt: at,
    });
    const { log } = await directoryLog();
    const refused = await erase(ada.email, log, await fileStore()).catch((error: Error) => error);
    expect((refused as Error).message).toContain(`is the only owner of ${school};`);
    expect((refused as Error).message).not.toContain(own.slug);
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(1);
    expect(await database.$count(organization, eq(organization.id, own.id))).toBe(1);
  });

  test("refuses a personal organization set up while it locks, unshown, erasing nothing", async () => {
    const ada = await person();
    const { target } = await previewAccountErasure({ database, email: ada.email });
    expect(target.personal).toBeNull();
    const committing = gate();
    const inserted = gate();
    const id = `erase-personal-late-${crypto.randomUUID()}`;
    // Setup's insert, its reference holding the account's row, still uncommitted
    // when the erasure finds no personal organization.
    const setup = database.transaction(async (transaction) => {
      await transaction.insert(organization).values({
        id,
        name: "Ada Fernley",
        slug: `p-${id.slice(-16)}`,
        createdAt: at,
        personalOwnerId: ada.id,
      });
      inserted.open();
      await committing.opened;
    });
    await inserted.opened;
    const { log } = await directoryLog();
    const erasing = eraseAccount({ database, target, log, files: await fileStore() }).catch(
      (error: Error) => error,
    );
    await waitForLock(`%from "user"%for update%`);
    committing.open();
    await setup;

    expect(((await erasing) as Error).message).toContain("changed since it was shown");
    expect(await database.$count(user, eq(user.id, ada.id))).toBe(1);
    expect(await database.$count(organization, eq(organization.id, id))).toBe(1);
  });
});
