// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  chooseNextActivity,
  readCourseProgress,
  submitAttempt,
} from "../../apps/server/application/index.ts";
import { LEARN_HOSTNAME, prepareClassroom } from "../../apps/server/fixtures/classroom.ts";
import { createDatabase } from "../../packages/db/index.ts";
import { attempt, member, organization, user } from "../../packages/db/schema/index.ts";
import {
  createMarkedDatabase,
  type Demo,
  type DemoLock,
  DemoRefused,
  inspectDemo,
  lockDemo,
  portInUse,
  prepareDemo,
  readDemo,
  readOrCreateDemo,
  resetDemo,
  type Seeder,
} from "./environment.ts";

/**
 * Real databases on the test server, made and dropped here: each test's demo
 * is its own, named by a random ID like any demo, and never the developer's.
 */
const target = process.env.TEST_DATABASE_URL;

/** A fixed moment, so a baseline's checks run at the same time on every run. */
const ANCHOR = new Date("2026-10-01T09:00:00Z");

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Ports nothing listens on, so `assertStopped` judges only what a test starts. */
async function freePorts(): Promise<Demo["ports"]> {
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    ports.push((server.address() as { port: number }).port);
    await new Promise((resolve) => server.close(resolve));
  }
  return { server: ports[0]!, learn: ports[1]!, console: ports[2]! };
}

function newWorktree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "braivo-demo-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A worktree of its own, and its demo, dropped afterwards whatever the test left. */
async function newDemo(root = newWorktree()): Promise<Demo> {
  const demo = {
    ...(await readOrCreateDemo(root, { BRAIVO_DEMO_DATABASE_URL: target })),
    ports: await freePorts(),
  };
  cleanups.push(() => query(target!, `drop database if exists "${demo.database}" with (force)`));
  return demo;
}

/** The demo's lock, released afterwards. */
async function locked(demo: Demo): Promise<DemoLock> {
  const lock = await lockDemo(demo);
  cleanups.push(() => lock.release());
  return lock;
}

async function query(url: string, sql: string, values: unknown[] = []) {
  const client = new Client(url);
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

const demoUrl = (demo: Demo) => {
  const url = new URL(target!);
  url.pathname = `/${demo.database}`;
  return url.href;
};

const databaseExists = async (demo: Demo) =>
  (await query(target!, "select 1 from pg_database where datname = $1", [demo.database])).length ===
  1;

/** Ends the connection holding the demo's lock, and only that one: other suites on this server may hold theirs. */
async function cutLock(demo: Demo): Promise<void> {
  const rows = await query(
    target!,
    `with lock as (select hashtextextended($1, 0) as key)
     select pg_terminate_backend(pid) as terminated from pg_locks, lock
     where locktype = 'advisory' and objsubid = 1
       and classid = ((key >> 32) & 4294967295)::oid and objid = (key & 4294967295)::oid`,
    [`braivo-dev-demo:${demo.id}`],
  );
  expect(rows).toEqual([{ terminated: true }]);
}

const count = async (demo: Demo, table: string) =>
  (await query(demoUrl(demo), `select count(*)::int as count from ${table}`))[0]!.count as number;

/**
 * Requires TEST_DATABASE_URL, whose role may create databases, as every
 * worktree's does. Each test creates, migrates, and drops databases, and the
 * stop checks wait out lingering connections: seconds, more under load.
 */
describe.skipIf(!target)("the development demo", { timeout: 30_000 }, () => {
  test("is prepared once: migrated, seeded, checked, then ready; relaunching keeps edits and history", async () => {
    const demo = await newDemo();
    const lock = await locked(demo);

    const prepared = await prepareDemo(lock, { now: ANCHOR });
    expect(prepared).toMatchObject({ state: "ready", scenario: 3, anchor: ANCHOR });
    expect(await inspectDemo(demo)).toMatchObject({
      kind: "ready",
      migrations: { pending: [], diverged: [] },
    });

    // As the console's group editor saves a rename.
    await query(demoUrl(demo), `update "group" set name = '7A · English' where id = $1`, [
      prepared.handles!.groupClassA,
    ]);
    const relaunched = await prepareDemo(lock, { now: new Date("2026-11-01T09:00:00Z") });
    expect(relaunched).toEqual(prepared);
    expect(await query(demoUrl(demo), `select name from "group"`)).toEqual([
      { name: "7A · English" },
    ]);
    expect(await count(demo, "organization")).toBe(1);

    // Its storage swapped for an unmarked directory: never served.
    rmSync(demo.storage, { recursive: true });
    mkdirSync(demo.storage);
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow(
      "is not a directory marked as this demo's storage",
    );
    // Gone: never recreated empty under data that may name its files.
    rmSync(demo.storage, { recursive: true });
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow(
      "this demo's storage, is missing",
    );
    expect(existsSync(demo.storage)).toBe(false);
  });

  test("its learners take different paths from the anchor, the same in every new demo", async () => {
    const learnHost = { hostname: LEARN_HOSTNAME, installation: false };
    /** A new demo: where the teacher sees each learner stand, and what each is offered next. */
    const prepareBaseline = async (demo: Demo) => {
      const { handles } = await prepareDemo(await locked(demo), { now: ANCHOR });
      const database = createDatabase(demoUrl(demo));
      cleanups.push(() => database.$client.end());
      const { courseEnglish: courseId } = handles!;
      const progress = await readCourseProgress({
        database,
        viewedBy: handles!.teacherClassA,
        courseId,
        host: { hostname: "localhost", installation: true },
        now: ANCHOR,
      });
      const next = async (learnerId: string) => {
        const activity = await chooseNextActivity({
          database,
          learnerId,
          courseId,
          host: learnHost,
          now: ANCHOR,
          timeZone: "UTC",
        });
        return activity.kind === "decided"
          ? `${activity.decision.intent} ${activity.objective.title}: ${activity.task.prompt}`
          : activity.kind;
      };
      return {
        database,
        handles: handles!,
        learnerStandings:
          progress.kind === "assessed"
            ? progress.overview.learners.map(({ name, standings }) => ({ name, ...standings }))
            : progress.kind,
        objectiveStandings:
          progress.kind === "assessed"
            ? progress.overview.objectives.map(({ title, standings }) => ({ title, ...standings }))
            : progress.kind,
        next: { sam: await next(handles!.sam), zofia: await next(handles!.zofia) },
      };
    };

    const first = await prepareBaseline(await newDemo());
    expect(first.learnerStandings).toEqual([
      { name: "Sam Nowak", unseen: 1, acquiring: 1, retained: 1, due: 0 },
      { name: "Zofia Wójcik", unseen: 0, acquiring: 0, retained: 3, due: 0 },
    ]);
    // The report's objective rows count the same standings.
    expect(first.objectiveStandings).toEqual([
      { title: "Greet someone for the time of day", unseen: 0, acquiring: 0, retained: 2, due: 0 },
      { title: "Ask for something politely", unseen: 0, acquiring: 1, retained: 1, due: 0 },
      { title: "Say goodbye", unseen: 1, acquiring: 0, retained: 1, due: 0 },
    ]);
    expect(first.next).toEqual({
      sam: 'reteach Ask for something politely: Complete the polite request: "Could I have a glass of water, ___?"',
      zofia: "caught-up",
    });
    // Nobody practised before their user, organization, or membership was
    // created. Read as written, through Drizzle: Better Auth's are timestamps
    // without a time zone, which SQL would compare in the session's.
    const made = await Promise.all(
      [user, organization, member].map((table) =>
        first.database.select({ at: table.createdAt }).from(table),
      ),
    );
    const practised = await first.database.select({ at: attempt.at }).from(attempt);
    expect(practised).toHaveLength(6);
    const firstPractised = Math.min(...practised.map(({ at }) => at.getTime()));
    expect(made.flat().filter(({ at }) => at.getTime() >= firstPractised)).toEqual([]);
    const { learnerStandings, objectiveStandings, next } = await prepareBaseline(await newDemo());
    expect({ learnerStandings, objectiveStandings, next }).toEqual({
      learnerStandings: first.learnerStandings,
      objectiveStandings: first.objectiveStandings,
      next: first.next,
    });

    // Sam types the request right: it is retained, with its passage to read, and goodbyes come next.
    const { database, handles } = first;
    const course = { database, learnerId: handles.sam, courseId: handles.courseEnglish };
    const retry = await chooseNextActivity({
      ...course,
      host: learnHost,
      now: ANCHOR,
      timeZone: "UTC",
    });
    const answered = await submitAttempt({
      ...course,
      host: learnHost,
      attemptId: "retry",
      taskId: retry.kind === "decided" ? retry.task.id : "",
      response: { text: "please" },
      now: new Date(ANCHOR.getTime() + 60_000),
    });
    expect(answered).toMatchObject({
      kind: "graded",
      grade: { outcome: "success", correctAnswer: "please" },
      passages: [{ quote: 'To ask for something politely, add "please"' }],
    });
    const after = await chooseNextActivity({
      ...course,
      host: learnHost,
      now: new Date(ANCHOR.getTime() + 2 * 60_000),
      timeZone: "UTC",
    });
    expect(after).toMatchObject({ kind: "decided", decision: { intent: "introduce" } });
    expect(after.kind === "decided" && after.objective.title).toBe("Say goodbye");

    // A day on, Zofia's first objective is due for review.
    const review = await chooseNextActivity({
      database,
      learnerId: handles.zofia,
      courseId: handles.courseEnglish,
      host: learnHost,
      now: new Date(ANCHOR.getTime() + 25 * 60 * 60_000),
      timeZone: "UTC",
    });
    expect(review).toMatchObject({ kind: "decided", decision: { intent: "review" } });
    expect(review.kind === "decided" && review.objective.title).toBe(
      "Greet someone for the time of day",
    );
  });

  test("an interrupted preparation is never ready, and only a reset recovers it", async () => {
    const demo = await newDemo();
    const interrupted: Seeder = () => Promise.reject(new Error("Interrupted."));
    const lock = await locked(demo);

    await expect(prepareDemo(lock, { now: ANCHOR, seed: interrupted })).rejects.toThrow(
      "Interrupted.",
    );
    expect(await inspectDemo(demo)).toMatchObject({ kind: "initializing" });
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow(
      `Preparing this demo did not finish, so it is not a baseline. Reset it, then launch again: bun run dev:demo:reset --environment ${demo.id}`,
    );
    // Never marked ready without the baseline it was seeded as.
    await expect(
      query(demoUrl(demo), "update dev_demo.environment set state = 'ready'"),
    ).rejects.toThrow("check constraint");

    await resetDemo(lock, { confirmed: demo.id, variables: {} });
    await lock.release();
    const recreated = await newDemo(demo.worktree);
    expect(recreated.id).not.toBe(demo.id);
    expect(await prepareDemo(await locked(recreated), { now: ANCHOR })).toMatchObject({
      state: "ready",
    });
  });

  test("one writer at a time: a second lock is refused, and a lock no longer held writes nothing", async () => {
    const demo = await newDemo();
    const held = await lockDemo(demo);
    await expect(lockDemo(demo)).rejects.toThrow("This demo is running or being prepared");

    // As when PostgreSQL drops a crashed launcher's connection: the holder
    // hears it, writes nothing more, and the next one takes the lock.
    await cutLock(demo);
    await expect(held.lost).resolves.toBeInstanceOf(Error);
    await expect(prepareDemo(held, { now: ANCHOR })).rejects.toThrow(
      "The demo's lock is no longer held",
    );
    await expect(resetDemo(held, { confirmed: demo.id, variables: {} })).rejects.toThrow(
      "The demo's lock is no longer held",
    );
    expect(await databaseExists(demo)).toBe(false);
    expect(existsSync(demo.storage)).toBe(false);

    const next = await lockDemo(demo);
    await next.release();
    await expect(prepareDemo(next, { now: ANCHOR })).rejects.toThrow(
      "The demo's lock is no longer held (released)",
    );

    // Lost while seeding: what the seeder wrote is never marked ready.
    const seeding = await lockDemo(demo);
    const cutWhileSeeding: Seeder = async (options) => {
      await cutLock(demo);
      await seeding.lost;
      return prepareClassroom(options);
    };
    await expect(prepareDemo(seeding, { now: ANCHOR, seed: cutWhileSeeding })).rejects.toThrow(
      "The demo's lock is no longer held",
    );
    expect(await inspectDemo(demo)).toMatchObject({ kind: "initializing" });
  });

  test("first launches racing in one worktree agree on one demo", async () => {
    const root = newWorktree();
    const module = join(import.meta.dirname, "environment.ts");
    const launches = Array.from({ length: 4 }, () =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { readOrCreateDemo } = await import(${JSON.stringify(module)}); console.log((await readOrCreateDemo(${JSON.stringify(root)}, process.env)).id);`,
        ],
        { env: { ...process.env, BRAIVO_DEMO_DATABASE_URL: target }, stdout: "pipe" },
      ),
    );
    const ids = await Promise.all(
      launches.map(async (launch) => (await new Response(launch.stdout).text()).trim()),
    );
    expect(new Set(ids)).toEqual(new Set([readDemo(root, {})!.id]));
  });

  test("serves 10 above the worktree's dev servers, on the ports it was created with", async () => {
    const root = newWorktree();
    const demo = await readOrCreateDemo(root, {
      BRAIVO_DEMO_DATABASE_URL: target,
      PORT: "3020",
      BRAIVO_URL: "http://localhost:5194",
      BRAIVO_LEARN_PORT: "5193",
    });
    cleanups.push(() => query(target!, `drop database if exists "${demo.database}" with (force)`));
    expect(demo.ports).toEqual({ server: 3030, learn: 5203, console: 5204 });
    expect(readDemo(root, { PORT: "3040" })?.ports).toEqual(demo.ports);

    const main = await readOrCreateDemo(newWorktree(), { BRAIVO_DEMO_DATABASE_URL: target });
    cleanups.push(() => query(target!, `drop database if exists "${main.database}" with (force)`));
    expect(main.ports).toEqual({ server: 3010, learn: 5183, console: 5184 });

    const high = newWorktree();
    await expect(
      readOrCreateDemo(high, { BRAIVO_DEMO_DATABASE_URL: target, PORT: "65530" }),
    ).rejects.toThrow("must be 65525 at most");
    expect(existsSync(join(high, ".dev-demo"))).toBe(false);
  });

  test("never adopts a database it did not mark, nor one marked for another", async () => {
    const demo = await newDemo();
    const lock = await locked(demo);
    // As a crash between creating the database and marking it leaves it.
    await query(target!, `create database "${demo.database}"`);
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow(
      `Database ${demo.database} exists but carries no demo marker`,
    );
    await expect(resetDemo(lock, { confirmed: demo.id, variables: {} })).rejects.toThrow(
      "is not marked as this demo's",
    );
    expect(await count(demo, "pg_tables where schemaname = 'public'")).toBe(0);
    expect(await databaseExists(demo)).toBe(true);

    await query(target!, `drop database "${demo.database}"`);
    await createMarkedDatabase(lock);
    await query(demoUrl(demo), "update dev_demo.environment set worktree = '/elsewhere'");
    expect(await inspectDemo(demo)).toEqual({ kind: "foreign" });
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow("is marked as another demo's");
    await expect(resetDemo(lock, { confirmed: demo.id, variables: {} })).rejects.toThrow(
      DemoRefused,
    );
    expect(await databaseExists(demo)).toBe(true);
  });

  test("a bad target, copied or edited settings, and a moved directory are refused", async () => {
    // Before anything is written, so a mistake leaves nothing to clean up.
    const fresh = newWorktree();
    await expect(readOrCreateDemo(fresh, {})).rejects.toThrow(
      "BRAIVO_DEMO_DATABASE_URL is not set",
    );
    for (const [url, refusal] of [
      ["postgres://db.example.com/postgres", "must be a postgres:// URL on localhost"],
      // node-postgres would connect to `host` instead of the URL's.
      ["postgres://localhost/postgres?host=db.example.com", "with no host parameter"],
      ["postgres://localhost:1/postgres", "Could not connect through BRAIVO_DEMO_DATABASE_URL"],
    ] as const) {
      await expect(readOrCreateDemo(fresh, { BRAIVO_DEMO_DATABASE_URL: url })).rejects.toThrow(
        refusal,
      );
    }
    expect(existsSync(join(fresh, ".dev-demo"))).toBe(false);

    const demo = await newDemo();
    const copy = newWorktree();
    cpSync(join(demo.worktree, ".dev-demo"), join(copy, ".dev-demo"), { recursive: true });
    expect(() => readDemo(copy, {})).toThrow("does not describe this worktree's demo");
    expect(() =>
      readDemo(demo.worktree, { BRAIVO_DEMO_DATABASE_URL: "postgres://localhost/other" }),
    ).toThrow("names another PostgreSQL target");

    const settings = join(demo.worktree, ".dev-demo", "environment.json");
    const saved = readFileSync(settings, "utf8");
    for (const edited of [saved.replace(/"learn": \d+/, `"learn": "5183"`), "null", "[]"]) {
      writeFileSync(settings, edited);
      expect(() => readDemo(demo.worktree, {})).toThrow("does not describe this worktree's demo");
    }
    writeFileSync(settings, saved);

    // Moved elsewhere and linked back: its storage would be outside the worktree.
    const moved = newWorktree();
    renameSync(join(demo.worktree, ".dev-demo"), join(moved, ".dev-demo"));
    symlinkSync(join(moved, ".dev-demo"), join(demo.worktree, ".dev-demo"));
    expect(() => readDemo(demo.worktree, {})).toThrow("is a link");
  });

  test("pending migrations wait for --migrate, which reseeds nothing; diverged ones and another scenario are refused", async () => {
    const demo = await newDemo();
    const lock = await locked(demo);
    // Ready before any migration, every committed one pending, as no launch
    // leaves it; its handles made up, as no organization exists to name.
    await createMarkedDatabase(lock);
    await query(
      demoUrl(demo),
      `update dev_demo.environment set state = 'ready', anchor = $1, handles = '{"organization": "made-up"}'`,
      [ANCHOR],
    );
    mkdirSync(demo.storage);
    writeFileSync(join(demo.storage, ".environment-id"), demo.id);

    const status = await inspectDemo(demo);
    expect(status).toMatchObject({ kind: "ready", migrations: { diverged: [] } });
    const pending = status.kind === "ready" ? status.migrations.pending : [];
    expect(pending.length).toBeGreaterThan(0);
    await expect(prepareDemo(lock, { now: ANCHOR })).rejects.toThrow(
      `This checkout has migrations the demo has not applied: ${pending.join(", ")}.`,
    );
    // Inspecting changed nothing.
    expect(await inspectDemo(demo)).toEqual(status);

    // Not while something uses the database: a launch whose lock was lost.
    const connected = new Client(demoUrl(demo));
    await connected.connect();
    await expect(prepareDemo(lock, { now: ANCHOR, migrate: true })).rejects.toThrow(
      "connection(s)",
    );
    await connected.end();

    expect(await prepareDemo(lock, { now: ANCHOR, migrate: true })).toMatchObject({
      state: "ready",
      anchor: ANCHOR,
      handles: { organization: "made-up" },
    });
    expect(await inspectDemo(demo)).toMatchObject({ migrations: { pending: [], diverged: [] } });
    expect(await count(demo, "organization")).toBe(0);

    await query(
      demoUrl(demo),
      "insert into drizzle.__braivo_migrations (hash, created_at, name) values ('elsewhere', 0, '29990101000000_elsewhere')",
    );
    await expect(prepareDemo(lock, { now: ANCHOR, migrate: true })).rejects.toThrow(
      "it has migrations this checkout does not (29990101000000_elsewhere)",
    );

    await query(demoUrl(demo), "delete from drizzle.__braivo_migrations where hash = 'elsewhere'");
    await query(demoUrl(demo), "update dev_demo.environment set scenario = 0");
    await expect(prepareDemo(lock, { now: ANCHOR, migrate: true })).rejects.toThrow(
      "it was seeded as scenario 0, and this checkout's is 3",
    );
  });

  test("reset deletes only what it owns, after every check, and another demo stays as it was", async () => {
    const demo = await newDemo();
    const other = await newDemo();
    const lock = await locked(demo);
    await prepareDemo(lock, { now: ANCHOR });
    await prepareDemo(await locked(other), { now: ANCHOR });
    writeFileSync(join(other.storage, "upload"), "kept");
    const untouched = async () => {
      expect(await databaseExists(demo)).toBe(true);
      expect(existsSync(join(demo.worktree, ".dev-demo", "environment.json"))).toBe(true);
      expect(existsSync(join(demo.storage, ".environment-id"))).toBe(true);
    };
    const reset = (variables = {}) => resetDemo(lock, { confirmed: demo.id, variables });

    await expect(resetDemo(lock, { confirmed: other.id, variables: {} })).rejects.toThrow(
      `"${other.id}" is not this demo's ID`,
    );
    await expect(reset({ DATABASE_URL: demoUrl(demo) })).rejects.toThrow(
      "is the development or a test database",
    );
    await expect(reset({ TEST_DATABASE_URL: "postgres://localhost/braivo_demo" })).rejects.toThrow(
      "is the development or a test database",
    );
    await untouched();

    // Something of the contributor's beside the demo's files.
    writeFileSync(join(demo.worktree, ".dev-demo", "notes.md"), "mine");
    await expect(reset()).rejects.toThrow("holds notes.md, which the demo did not put there");
    rmSync(join(demo.worktree, ".dev-demo", "notes.md"));
    await untouched();

    // Storage swapped for a link to somewhere else, marked as the demo's.
    const elsewhere = newWorktree();
    writeFileSync(join(elsewhere, ".environment-id"), demo.id);
    const parked = join(newWorktree(), "storage");
    renameSync(demo.storage, parked);
    symlinkSync(elsewhere, demo.storage);
    await expect(reset()).rejects.toThrow("is not a directory marked as this demo's storage");
    expect(readFileSync(join(elsewhere, ".environment-id"), "utf8")).toBe(demo.id);
    rmSync(demo.storage);
    renameSync(parked, demo.storage);
    await untouched();

    const connected = new Client(demoUrl(demo));
    await connected.connect();
    await expect(reset()).rejects.toThrow("connection(s)");
    await connected.end();

    // A server left running, on either loopback address.
    for (const host of ["127.0.0.1", "::1"]) {
      const listening: Server = createServer();
      await new Promise<void>((resolve) => listening.listen(demo.ports.server, host, resolve));
      expect(await portInUse(demo.ports.server)).toBe(true);
      await expect(reset()).rejects.toThrow(`Something listens on port ${demo.ports.server}`);
      await new Promise((resolve) => listening.close(resolve));
    }
    await untouched();

    mkdirSync(join(demo.storage, "uploads"));
    await reset();
    expect(await databaseExists(demo)).toBe(false);
    expect(existsSync(join(demo.worktree, ".dev-demo"))).toBe(false);
    expect(readDemo(demo.worktree, {})).toBeUndefined();

    expect(await inspectDemo(other)).toMatchObject({ kind: "ready" });
    expect(readFileSync(join(other.storage, "upload"), "utf8")).toBe("kept");
  });
});
