// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import {
  attempt,
  learnerEvidence,
  learnerHistoryState,
  member,
  objective,
  organization,
  user,
} from "@braivo/db/schema";
import { clearLearningData, createTask, sharedDatabase } from "@braivo/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

// The operator's command against a real database (access-48): what it says and
// asks before anything is erased, and the log it leaves. What erasing removes,
// and what stays fenced, is `application/erase-history.test.ts`'s.

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const prefix = "learner-erase-cli-test";
const fernwood = `${prefix}-fernwood`;
const ada = { id: `${prefix}-ada`, name: "Ada Fernley", email: `${prefix}-ada@fernwood.example` };
const owner = { id: `${prefix}-owner`, name: "Olive Fern", email: `${prefix}-o@fernwood.example` };
const at = new Date("2026-09-01T08:00:00.000Z");
const key = "erasure-log-test-key-that-is-long-enough";

let logDirectory = "";

async function run(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: connectionString ?? "",
      BRAIVO_ERASURE_LOG: logDirectory,
      BRAIVO_ERASURE_LOG_HMAC_KEY: key,
      ...options.env,
    },
    stdin: new Blob([options.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const erase = (...more: string[]) => [
  "learner",
  "erase-history",
  "--email",
  ada.email,
  "--organization",
  fernwood,
  ...more,
];

const history = async () => ({
  attempts: await database.$count(attempt, eq(attempt.learnerId, ada.id)),
  evidence: await database.$count(learnerEvidence, eq(learnerEvidence.learnerId, ada.id)),
});

async function clear() {
  await clearLearningData(database, fernwood);
  await database.delete(user).where(inArray(user.id, [ada.id, owner.id]));
  await database.delete(organization).where(eq(organization.id, fernwood));
}

async function logRecords() {
  return Promise.all(
    (await readdir(logDirectory)).map(async (name) => ({
      name,
      record: JSON.parse(await readFile(join(logDirectory, name), "utf8")) as Record<
        string,
        unknown
      >,
    })),
  );
}

// Each test runs the CLI as several processes in turn: past the default timeout while the whole
// suite loads the machine.
describe.skipIf(!connectionString)("learner erase-history", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
    logDirectory = await mkdtemp(join(tmpdir(), `${prefix}-log-`));
    await database.insert(user).values(
      [ada, owner].map((person) => ({
        ...person,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await database
      .insert(organization)
      .values({ id: fernwood, name: "Fernwood School", slug: fernwood, createdAt: at });
    await database.insert(member).values([
      {
        id: `${prefix}-m1`,
        organizationId: fernwood,
        userId: ada.id,
        role: "member",
        createdAt: at,
      },
      {
        id: `${prefix}-m2`,
        organizationId: fernwood,
        userId: owner.id,
        role: "owner",
        createdAt: at,
      },
    ]);
    const objectiveId = `${prefix}-objective`;
    await database
      .insert(objective)
      .values({ id: objectiveId, organizationId: fernwood, title: "Greetings" });
    const taskId = await createTask(database, {
      organizationId: fernwood,
      objectiveId,
      body: { kind: "choice", prompt: "Hello?", options: ["Bonjour", "Merci"], answer: 0 },
      createdAt: at,
    });
    await database.insert(attempt).values({
      id: "a1",
      learnerId: ada.id,
      organizationId: fernwood,
      taskId,
      response: { choice: 0 },
      at,
    });
    await database.insert(learnerEvidence).values({
      id: "attempt:a1:x",
      learnerId: ada.id,
      organizationId: fernwood,
      objectiveId,
      outcome: "success",
      at,
    });
  });

  afterAll(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
  });

  test("shows the installation, account, organization, and counts, and needs the slug typed back", async () => {
    const wrong = await run(erase(), { stdin: "not-the-slug\n" });
    expect(wrong.code).toBe(1);
    const { host, pathname } = new URL(connectionString ?? "");
    expect(wrong.stdout).toContain(`${host}${pathname}`);
    expect(wrong.stdout).toContain(ada.email);
    expect(wrong.stdout).toContain(ada.id);
    expect(wrong.stdout).toContain(fernwood);
    expect(wrong.stdout).toContain("attempts 1, evidence 1");
    expect(wrong.stdout).toContain("History:      epoch 0");
    expect(wrong.stdout).toContain("Membership:   kept");
    expect(wrong.stderr).toContain("Nothing was erased");
    expect(await history()).toEqual({ attempts: 1, evidence: 1 });
    expect(await readdir(logDirectory)).toEqual([]);

    // Input ended without an answer, as with no terminal: never a yes.
    const silent = await run(erase(), { stdin: "" });
    expect(silent.code).toBe(1);
    expect(await history()).toEqual({ attempts: 1, evidence: 1 });

    const typed = await run(erase(), { stdin: `${fernwood}\n` });
    expect(typed.code).toBe(0);
    expect(typed.stdout).toContain("Erased:       attempts 1, evidence 1");
    expect(await history()).toEqual({ attempts: 0, evidence: 0 });
  });

  test("--yes needs no answer, and the log record is written, private, and done", async () => {
    const done = await run(erase("--yes"));
    expect(done.code).toBe(0);
    expect(await history()).toEqual({ attempts: 0, evidence: 0 });

    const [log, ...more] = await logRecords();
    expect(more).toEqual([]);
    expect(log?.record).toMatchObject({
      format: "braivo-erasure-log",
      version: 2,
      scope: "organization",
      userId: ada.id,
      organizationId: fernwood,
      epoch: 1,
      endMembership: false,
      doneAt: expect.any(String),
    });
    expect(done.stdout).toContain(String(log?.record.id));
    const { mode } = await stat(join(logDirectory, log!.name));
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.stringify(log?.record)).not.toContain(ada.email);
  });

  test("--end-membership ends it, and rejoining leaves the fence", async () => {
    const done = await run(erase("--yes", "--end-membership"));
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("Membership:   ended");
    const where = and(
      eq(learnerHistoryState.learnerId, ada.id),
      eq(learnerHistoryState.organizationId, fernwood),
    );
    expect((await logRecords())[0]?.record.endMembership).toBe(true);

    const rejoined = await run(
      ["organization", "add-member", "--slug", fernwood, "--email", ada.email],
      {
        env: {
          BETTER_AUTH_SECRET: "cli-test-secret-that-is-long-enough-32",
          BRAIVO_URL: "http://localhost:3000",
        },
      },
    );
    expect(rejoined.code, rejoined.stderr).toBe(0);
    const [back] = await database.select().from(learnerHistoryState).where(where);
    expect(back?.epoch).toBe(1);
  });

  test("refuses, erasing nothing: no log configured, no log directory, a bad target, or nothing to name", async () => {
    const unset = await run(erase("--yes"), { env: { BRAIVO_ERASURE_LOG: "" } });
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain("BRAIVO_ERASURE_LOG");
    const noKey = await run(erase("--yes"), { env: { BRAIVO_ERASURE_LOG_HMAC_KEY: "" } });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("BRAIVO_ERASURE_LOG_HMAC_KEY");

    const missing = await run(erase("--yes"), {
      env: { BRAIVO_ERASURE_LOG: join(logDirectory, "not-there") },
    });
    expect(missing.code).toBe(1);

    const stranger = await run([
      "learner",
      "erase-history",
      "--email",
      "nobody@fernwood.example",
      "--organization",
      fernwood,
      "--yes",
    ]);
    expect(stranger.code).toBe(1);
    expect(stranger.stderr).toContain("No account");

    expect((await run(["learner", "erase-history", "--email", ada.email])).code).toBe(1);

    expect(await history()).toEqual({ attempts: 1, evidence: 1 });
    expect(
      await database.$count(learnerHistoryState, eq(learnerHistoryState.learnerId, ada.id)),
    ).toBe(0);
    expect(await readdir(logDirectory)).toEqual([]);
  });
});
