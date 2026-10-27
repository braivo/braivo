// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { Client } from "pg";

import {
  type ClassroomHandles,
  LEARN_HOSTNAME,
  prepareClassroom,
  SCENARIO_VERSION,
} from "../../apps/server/fixtures/classroom.ts";
import {
  type MigrationState,
  readMigrationState,
  runMigrations,
} from "../../packages/db/migrate.ts";
import { DEFAULT_PORTS, demoPorts, type DevPorts, readDevPorts } from "../dev-ports.ts";

/**
 * A worktree's demo: one PostgreSQL database and one storage directory it
 * created and marked as its own, prepared once with the classroom and kept
 * across launches (docs/adr/0043-development-demo.md). One resolver for every
 * command, so preparing, verifying, launching, and resetting all name the
 * same database, storage, ports, and secret.
 */

/** In the worktree, gitignored; not `tmp/`, which is scratch, nor `local/`, which every worktree shares. */
const DEMO_DIRECTORY = ".dev-demo";

/**
 * What `DEMO_DIRECTORY` holds, and all it may hold: reset deletes nothing
 * else. One settings file, secrets included and readable by its owner alone,
 * so no half of it can outlive the other.
 */
const SETTINGS = "environment.json";
const STORAGE = "storage";

/**
 * A database on the local PostgreSQL server the demo is created on, through
 * which it connects to create, lock, and drop its own: chosen by the
 * contributor once, never derived from `DATABASE_URL`.
 */
const TARGET_VARIABLE = "BRAIVO_DEMO_DATABASE_URL";

/** Hosts only this machine reaches; anything else is refused as a target. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Above the worktree's dev servers', so the demo runs beside them, and beside
 * other worktrees' demos as their dev servers do (ADR 0014).
 */
function newDemoPorts(variables: Variables): DevPorts {
  const ports = demoPorts(readDevPorts(variables));
  // Refused before anything is written: settings naming no port could not be reset.
  if (Object.values(ports).some((port) => port > 65_535)) {
    throw new DemoRefused("The demo serves 10 above each dev port, which must be 65525 at most.");
  }
  return ports;
}

type Variables = Readonly<Record<string, string | undefined>>;

export type Demo = {
  /** Random, and the only thing that grants ownership: a name or a path never does. */
  id: string;
  /** The worktree's canonical path. */
  worktree: string;
  database: string;
  storage: string;
  ports: DevPorts;
  /** The target, credentials included: never printed. */
  targetUrl: string;
  authSecret: string;
};

/** A refusal to act, saying why and what to do instead; nothing was changed. */
export class DemoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoRefused";
  }
}

/** The worktree's demo, or `undefined` before the first `dev:demo` there. */
export function readDemo(root: string, variables: Variables): Demo | undefined {
  const directory = join(root, DEMO_DIRECTORY);
  if (!lstatSync(directory, { throwIfNoEntry: false })) return undefined;
  const worktree = realpathSync(root);
  const refuse = (problem: string) =>
    new DemoRefused(
      `${directory} ${problem}. Nothing was changed. If no braivo_demo_ database of this worktree's is left on the demo's PostgreSQL, delete ${DEMO_DIRECTORY}/ to start again.`,
    );
  // A link, as to a directory moved elsewhere: its storage is not this worktree's.
  if (
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== join(worktree, DEMO_DIRECTORY)
  ) {
    throw refuse("is a link, not this worktree's own directory");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, SETTINGS), "utf8"));
  } catch (error) {
    throw refuse(`is unreadable or incomplete (${(error as Error).message})`);
  }
  const demo = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<Demo>;
  const { ports } = demo;
  const valid =
    // Copied from another worktree, or edited: it names what this one does not own.
    typeof demo.id === "string" &&
    /^[0-9a-f]{12}$/.test(demo.id) &&
    demo.worktree === worktree &&
    demo.database === databaseName(demo.id) &&
    demo.storage === join(directory, STORAGE) &&
    typeof demo.authSecret === "string" &&
    demo.authSecret.length >= 32 &&
    typeof demo.targetUrl === "string" &&
    typeof ports === "object" &&
    ports !== null &&
    Object.keys(DEFAULT_PORTS).every((name) => {
      const port = ports[name as keyof DevPorts];
      return Number.isInteger(port) && port > 0 && port < 65_536;
    }) &&
    new Set(Object.values(ports)).size === Object.keys(DEFAULT_PORTS).length;
  if (!valid) throw refuse("does not describe this worktree's demo");
  readTarget(demo.targetUrl);
  const configured = variables[TARGET_VARIABLE]?.trim();
  if (configured && configured !== demo.targetUrl) {
    throw new DemoRefused(
      `${TARGET_VARIABLE} names another PostgreSQL target than this demo was created on. Unset it to keep using this demo, or reset the demo first.`,
    );
  }
  return demo as Demo;
}

/**
 * The worktree's demo, created if there is none: a new ID and auth secret on
 * the target `BRAIVO_DEMO_DATABASE_URL` names, once that target is proven to
 * accept the connection and let it create databases. Its directory appears
 * whole, renamed into place once written, so two first launches agree on one
 * demo.
 */
export async function readOrCreateDemo(root: string, variables: Variables): Promise<Demo> {
  const existing = readDemo(root, variables);
  if (existing) return existing;

  const targetUrl = readTarget(variables[TARGET_VARIABLE]);
  await assertMayCreateDatabases(targetUrl);
  const worktree = realpathSync(root);
  const id = randomBytes(6).toString("hex");
  const demo: Demo = {
    id,
    worktree,
    database: databaseName(id),
    storage: join(worktree, DEMO_DIRECTORY, STORAGE),
    ports: newDemoPorts(variables),
    targetUrl,
    authSecret: randomBytes(32).toString("base64url"),
  };
  const draft = mkdtempSync(join(worktree, `${DEMO_DIRECTORY}-`));
  try {
    writeFileSync(join(draft, SETTINGS), `${JSON.stringify(demo, null, 2)}\n`, { mode: 0o600 });
    renameSync(draft, join(worktree, DEMO_DIRECTORY));
  } catch (error) {
    rmSync(draft, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    // Another launch created it first: that one is the demo.
    if (code === "ENOTEMPTY" || code === "EEXIST") return readDemo(root, variables)!;
    throw error;
  }
  return demo;
}

/**
 * Explicit, and local: a target on another machine, or reached through a
 * name that is not loopback, is never one this tool may create databases on.
 */
function readTarget(value: string | undefined): string {
  const target = value?.trim();
  if (!target) {
    throw new DemoRefused(
      `${TARGET_VARIABLE} is not set. Name a database on your local PostgreSQL through which the demo may create its own, e.g. ${TARGET_VARIABLE}=postgres://localhost/postgres in .env.`,
    );
  }
  const url = URL.canParse(target) ? new URL(target) : undefined;
  if (
    !url ||
    !/^postgres(ql)?:$/.test(url.protocol) ||
    !LOOPBACK.has(url.hostname) ||
    // node-postgres connects to these over the URL's host.
    url.searchParams.has("host") ||
    url.searchParams.has("hostaddr")
  ) {
    throw new DemoRefused(
      `${TARGET_VARIABLE} must be a postgres:// URL on localhost, 127.0.0.1, or [::1], with no host parameter.`,
    );
  }
  return target;
}

/** Before anything is written, so a mistyped target leaves nothing to clean up. */
async function assertMayCreateDatabases(targetUrl: string): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await withClient(targetUrl, async (client) => {
      const { rows } = await client.query<{ allowed: boolean }>(
        "select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user",
      );
      return rows[0]?.allowed === true;
    });
  } catch (error) {
    throw new DemoRefused(
      `Could not connect through ${TARGET_VARIABLE} (${(error as Error).message}). Check it and retry; nothing was created.`,
    );
  }
  if (!allowed) {
    throw new DemoRefused(
      `The role ${TARGET_VARIABLE} connects as may not create databases. Grant it CREATEDB (alter role <name> createdb), or name a role that may; nothing was created.`,
    );
  }
}

/** At most 24 bytes, within PostgreSQL's 63, and no character needing quotes. */
function databaseName(id: string): string {
  return `braivo_demo_${id}`;
}

function databaseUrl(demo: Demo, options?: { readOnly: true }): string {
  const url = new URL(demo.targetUrl);
  url.pathname = `/${demo.database}`;
  if (options?.readOnly) url.searchParams.set("options", "-c default_transaction_read_only=on");
  return url.href;
}

/** One connection for `use`, always closed. */
async function withClient<T>(url: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    return await use(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * What the demo's server runs with, and nothing inherited: no mail, AI,
 * Google, or bucket. Without mail it logs codes and listens on `BRAIVO_URL`'s
 * loopback host alone (`apps/server/config.ts`).
 */
export function serverEnvironment(demo: Demo): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(demo),
    BETTER_AUTH_SECRET: demo.authSecret,
    BRAIVO_URL: consoleUrl(demo),
    PORT: String(demo.ports.server),
    BRAIVO_FILES: demo.storage,
  };
}

/** Where the demo's database is, for people: no password. */
export function describeDatabase(demo: Demo): string {
  const { username, host } = new URL(demo.targetUrl);
  return `${demo.database} on ${host}${username ? ` as ${decodeURIComponent(username)}` : ""}`;
}

/**
 * On `127.0.0.1`, not `localhost`: cookies ignore ports, so `bun run dev`'s
 * console on `localhost` keeps its sign-in apart. Still loopback, where the
 * server logs sign-in codes rather than mailing them.
 */
export const consoleUrl = (demo: Demo) => `http://127.0.0.1:${demo.ports.console}`;
export const learnUrl = (demo: Demo) => `http://${LEARN_HOSTNAME}:${demo.ports.learn}`;

/** The demo's own record of itself, in its database, outside Braivo's schema. */
export type Marker = {
  id: string;
  worktree: string;
  storage: string;
  /**
   * None for migrating: Drizzle applies all pending migrations in one
   * transaction, so an interrupted run leaves them pending.
   */
  state: "initializing" | "ready";
  scenario: number;
  /** When it was seeded, and what: set once, before it is first ready. */
  anchor: Date | null;
  handles: ClassroomHandles | null;
};

/** What the target holds for this demo, read without changing anything. */
export type DemoStatus =
  | { kind: "absent" }
  /** A database by its name, without its marker: never adopted, never dropped. */
  | { kind: "unowned" }
  /** Marked, by another demo or for another worktree or storage. */
  | { kind: "foreign" }
  | { kind: "initializing"; marker: Marker }
  | { kind: "ready"; marker: Marker; migrations: MigrationState };

export async function inspectDemo(demo: Demo): Promise<DemoStatus> {
  const exists = await withClient(demo.targetUrl, async (client) => {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [
      demo.database,
    ]);
    return rowCount === 1;
  });
  if (!exists) return { kind: "absent" };

  const url = databaseUrl(demo, { readOnly: true });
  const markers = await withClient(url, async (client) => {
    const { rows } = await client.query<{ found: boolean }>(
      "select to_regclass('dev_demo.environment') is not null as found",
    );
    if (!rows[0]?.found) return undefined;
    return (
      await client.query<Marker>(
        "select id, worktree, storage, state, scenario, anchor, handles from dev_demo.environment",
      )
    ).rows;
  });
  if (!markers) return { kind: "unowned" };
  const [marker] = markers;
  if (
    markers.length !== 1 ||
    marker!.id !== demo.id ||
    marker!.worktree !== demo.worktree ||
    marker!.storage !== demo.storage
  ) {
    return { kind: "foreign" };
  }
  if (marker!.state === "initializing") return { kind: "initializing", marker: marker! };
  return { kind: "ready", marker: marker!, migrations: await readMigrationState(url) };
}

/**
 * The demo's single-writer lock, which every command that changes it takes
 * and passes on: PostgreSQL's session lock on the target, held by one
 * connection and released by the server when that connection ends, so a
 * crashed holder leaves nothing stale. `lost` settles if the connection ends
 * first, and `assertHeld` refuses from then on.
 */
export type DemoLock = {
  demo: Demo;
  lost: Promise<Error>;
  assertHeld(): void;
  release(): Promise<void>;
};

export async function lockDemo(demo: Demo): Promise<DemoLock> {
  const client = new Client({ connectionString: demo.targetUrl, connectionTimeoutMillis: 10_000 });
  let released = false;
  let lostWith: Error | undefined;
  const lost = new Promise<Error>((resolve) => {
    const lose = (error?: Error) => {
      if (released || lostWith) return;
      lostWith = error ?? new Error("its connection ended");
      resolve(lostWith);
    };
    client.on("error", lose);
    client.on("end", () => lose());
  });
  const release = async () => {
    released = true;
    await client.end().catch(() => {});
  };
  let locked = false;
  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [`braivo-dev-demo:${demo.id}`],
    );
    locked = rows[0]?.locked === true;
  } finally {
    if (!locked) await release();
  }
  if (!locked) {
    throw new DemoRefused(
      "This demo is running or being prepared, migrated, or reset in another terminal. Stop that first.",
    );
  }
  return {
    demo,
    lost,
    assertHeld() {
      if (released || lostWith) {
        throw new DemoRefused(
          `The demo's lock is no longer held (${lostWith?.message ?? "released"}), so nothing more is changed.`,
        );
      }
    },
    release,
  };
}

/** What preparing a new demo runs on its migrated database: the classroom, seeded and checked. */
export type Seeder = typeof prepareClassroom;

/**
 * Brings the demo to ready under its lock: a new one is created, migrated,
 * seeded, and checked, then marked ready; a ready one is left as it is, edits
 * and practice included, unless `migrate` applies pending migrations. Any
 * other state is refused with what to do.
 *
 * The lock is checked before every step that writes. A step already running
 * when it is lost, such as seeding, runs on, but the check before marking
 * ready stops it there, and reset refuses while its connections are open.
 */
export async function prepareDemo(
  lock: DemoLock,
  options: { migrate?: boolean; now: Date; seed?: Seeder },
): Promise<Marker> {
  const { demo } = lock;
  const { migrate = false, now, seed = prepareClassroom } = options;
  lock.assertHeld();
  const status = await inspectDemo(demo);
  switch (status.kind) {
    case "absent": {
      lock.assertHeld();
      // Kept if an earlier first launch made it: marked, so the demo's.
      if (inspectStorage(demo) === "absent") {
        mkdirSync(demo.storage);
        writeFileSync(join(demo.storage, STORAGE_MARKER), demo.id);
      }
      await createMarkedDatabase(lock);
      lock.assertHeld();
      await runMigrations(databaseUrl(demo));
      lock.assertHeld();
      const handles = await seed({
        databaseUrl: databaseUrl(demo),
        authSecret: demo.authSecret,
        baseUrl: consoleUrl(demo),
        now,
      });
      lock.assertHeld();
      return markReady(demo, now, handles);
    }
    case "unowned":
      throw new DemoRefused(
        `Database ${demo.database} exists but carries no demo marker, as after an interrupted first launch. Nothing was changed. Inspect it, and if it is this demo's, drop it (dropdb ${demo.database}) and launch again.`,
      );
    case "foreign":
      throw new DemoRefused(
        `Database ${demo.database} is marked as another demo's, or for another worktree or storage. Nothing was changed.`,
      );
    case "initializing":
      throw new DemoRefused(
        `Preparing this demo did not finish, so it is not a baseline. Reset it, then launch again: ${resetCommand(demo)}`,
      );
    case "ready": {
      const { marker, migrations } = status;
      const incompatible = incompatibilities(demo, marker, migrations);
      if (incompatible.length > 0) {
        throw new DemoRefused(`This demo cannot run here: ${incompatible.join("; ")}.`);
      }
      assertStorage(demo);
      if (migrations.pending.length === 0) return marker;
      if (!migrate) {
        throw new DemoRefused(
          `This checkout has migrations the demo has not applied: ${migrations.pending.join(", ")}. Review them, then apply them, keeping the demo's data: ${MIGRATE_COMMAND}`,
        );
      }
      await assertStopped(demo);
      lock.assertHeld();
      await runMigrations(databaseUrl(demo));
      const after = await readMigrationState(databaseUrl(demo));
      if (after.pending.length > 0 || after.diverged.length > 0) {
        throw new DemoRefused("Migrating left the demo's schema unlike this checkout's.");
      }
      return marker;
    }
  }
}

const MIGRATE_COMMAND = "bun run dev:demo --migrate";
const resetCommand = (demo: Demo) => `bun run dev:demo:reset --environment ${demo.id}`;

/** Why this checkout cannot serve a demo it otherwise owns, or nothing. */
export function incompatibilities(
  demo: Demo,
  marker: Marker,
  migrations: MigrationState,
): string[] {
  return [
    ...(marker.scenario === SCENARIO_VERSION
      ? []
      : [
          `it was seeded as scenario ${marker.scenario}, and this checkout's is ${SCENARIO_VERSION}: keep it with a checkout of its own, or reset it for the new baseline (${resetCommand(demo)})`,
        ]),
    ...(migrations.diverged.length === 0
      ? []
      : [
          `it has migrations this checkout does not (${migrations.diverged.join(", ")}), as after migrations are regenerated: use the checkout it came from, or reset it (${resetCommand(demo)})`,
        ]),
  ];
}

/**
 * Drops the demo's database and storage and deletes its settings, secret
 * included, so no old session signs in again: only for the demo `confirmed` names, its
 * marker matching, its directory holding only what the demo put there,
 * nothing connected to it, and nothing listening on its ports. Every check
 * comes before the first deletion, and each deletion tolerates an earlier
 * reset's, so a reset interrupted before the settings go is finished by
 * running it again.
 */
export async function resetDemo(
  lock: DemoLock,
  options: { confirmed: string; variables: Variables },
): Promise<void> {
  const { demo } = lock;
  if (options.confirmed !== demo.id) {
    throw new DemoRefused(
      `"${options.confirmed}" is not this demo's ID, ${demo.id}. Nothing was changed.`,
    );
  }
  assertNotOrdinary(demo, options.variables);
  lock.assertHeld();
  const status = await inspectDemo(demo);
  if (status.kind === "unowned" || status.kind === "foreign") {
    throw new DemoRefused(
      `Database ${demo.database} is not marked as this demo's, so it is not dropped. Nothing was changed.`,
    );
  }
  const directory = join(demo.worktree, DEMO_DIRECTORY);
  const unexpected = readdirSync(directory).filter((name) => ![SETTINGS, STORAGE].includes(name));
  if (unexpected.length > 0) {
    throw new DemoRefused(
      `${directory} holds ${unexpected.join(", ")}, which the demo did not put there: move it out first. Nothing was changed.`,
    );
  }
  const storage = inspectStorage(demo);
  await assertStopped(demo);
  lock.assertHeld();

  if (status.kind !== "absent") {
    // Not `with (force)`: a connection arriving since the check refuses it.
    await withClient(demo.targetUrl, (client) => client.query(`drop database "${demo.database}"`));
    lock.assertHeld();
  }
  // Not following links: `inspectStorage` refused one in its place.
  if (storage === "owned") rmSync(demo.storage, { recursive: true });
  // The settings last, so a reset interrupted before them is run again; one
  // interrupted after them leaves an empty directory, refused until deleted.
  rmSync(join(directory, SETTINGS));
  rmdirSync(directory);
}

/** Neither the development database nor a test one, whatever its marker says. */
function assertNotOrdinary(demo: Demo, variables: Variables): void {
  const named = (variable: string) => {
    const value = variables[variable];
    return value && URL.canParse(value) ? decodeURIComponent(new URL(value).pathname.slice(1)) : "";
  };
  const development = named("DATABASE_URL");
  const test = named("TEST_DATABASE_URL");
  // A worktree's test database is the configured one, suffixed (ADR 0014).
  if (
    demo.database === development ||
    (test && (demo.database === test || demo.database.startsWith(`${test}_`)))
  ) {
    throw new DemoRefused(
      `${demo.database} is the development or a test database, never a demo's. Nothing was changed.`,
    );
  }
}

/**
 * Proves the demo stopped, beyond its lock: a launch whose lock connection
 * was cut, or whose servers outlived it (a launcher killed outright), still
 * holds connections or ports.
 */
async function assertStopped(demo: Demo): Promise<void> {
  const connected = await withClient(demo.targetUrl, async (client) => {
    let count = 0;
    // For up to two seconds, as `drop database` waits its five: a connection
    // just closed, this module's own included, lingers there for a moment.
    for (let waited = 0; waited <= 2_000; waited += 100) {
      const { rows } = await client.query<{ count: number }>(
        "select count(*)::int as count from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [demo.database],
      );
      count = rows[0]?.count ?? 0;
      if (count === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return count;
  });
  if (connected > 0) {
    throw new DemoRefused(
      `${connected} connection(s) to ${demo.database} are open: stop the demo's server first. Nothing was changed.`,
    );
  }
  for (const port of Object.values(demo.ports)) {
    if (await portInUse(port)) {
      throw new DemoRefused(
        `Something listens on port ${port}, one of the demo's: stop the demo, or whatever else uses it, first. Nothing was changed.`,
      );
    }
  }
}

/**
 * Whether a server answers on `port` on this machine, over IPv4 or IPv6:
 * whichever it bound, the demo's or anything else.
 */
export async function portInUse(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host, timeout: 1_000 });
      const answer = (answered: boolean) => {
        socket.destroy();
        resolve(answered);
      };
      socket.once("connect", () => answer(true));
      socket.once("timeout", () => answer(false));
      socket.once("error", () => answer(false));
    });
  return (await Promise.all(["127.0.0.1", "::1"].map(answers))).includes(true);
}

/** Names the storage as the demo's, so reset deletes only a directory that says so. */
const STORAGE_MARKER = ".environment-id";

/**
 * `absent`, or `owned`: a real directory (not a link) at the demo's path,
 * naming the demo. Anything else is refused, never deleted or served.
 */
function inspectStorage(demo: Demo): "absent" | "owned" {
  const found = lstatSync(demo.storage, { throwIfNoEntry: false });
  if (!found) return "absent";
  let owner: string | undefined;
  try {
    owner = found.isDirectory()
      ? readFileSync(join(demo.storage, STORAGE_MARKER), "utf8")
      : undefined;
  } catch {
    owner = undefined;
  }
  if (owner !== demo.id) {
    throw new DemoRefused(
      `${demo.storage} is not a directory marked as this demo's storage, so it is neither used nor deleted. Nothing was changed.`,
    );
  }
  return "owned";
}

/**
 * A prepared demo's storage, owned and present: never recreated, as its
 * database may name files that were in it.
 */
export function assertStorage(demo: Demo): void {
  if (inspectStorage(demo) === "absent") {
    throw new DemoRefused(
      `${demo.storage}, this demo's storage, is missing, so files its data names are gone. Nothing was changed. Restore it, or reset the demo: ${resetCommand(demo)}`,
    );
  }
}

/**
 * Creates the database, then its marker in one transaction, so the database is
 * either unmarked (`unowned`, from a crash in between) or the demo's,
 * `initializing`. Exported for tests that need a demo in a state preparing
 * never leaves.
 */
export async function createMarkedDatabase(lock: DemoLock): Promise<void> {
  const { demo } = lock;
  lock.assertHeld();
  await withClient(demo.targetUrl, (client) => client.query(`create database "${demo.database}"`));
  lock.assertHeld();
  await withClient(databaseUrl(demo), async (client) => {
    await client.query("begin");
    await client.query(`
      create schema dev_demo;
      create table dev_demo.environment (
        id text primary key,
        worktree text not null,
        storage text not null,
        state text not null check (state in ('initializing', 'ready')),
        scenario integer not null,
        anchor timestamptz,
        handles jsonb,
        -- Once ready, always with the baseline it was seeded as.
        check (state = 'initializing' or (anchor is not null and handles is not null))
      );
    `);
    await client.query(
      "insert into dev_demo.environment (id, worktree, storage, state, scenario) values ($1, $2, $3, 'initializing', $4)",
      [demo.id, demo.worktree, demo.storage, SCENARIO_VERSION],
    );
    await client.query("commit");
  });
}

/**
 * What a ready demo of this checkout's scenario was seeded with and may have
 * since lost: its organization and its people, by the handles this scenario
 * names. Notes, not faults: the demo is the contributor's to change, deleting
 * what the baseline made included.
 */
export async function missingBaseline(demo: Demo, marker: Marker): Promise<string[]> {
  const { handles } = marker;
  if (!handles) return [];
  return withClient(databaseUrl(demo, { readOnly: true }), async (client) => {
    const count = async (sql: string, ids: string[]) =>
      (await client.query<{ count: number }>(sql, [ids])).rows[0]?.count ?? 0;
    const people = [
      handles.administrator,
      handles.author,
      handles.teacherClassA,
      handles.sam,
      handles.zofia,
    ];
    return [
      ...((await count("select count(*)::int as count from organization where id = any($1)", [
        handles.organization,
      ])) === 1
        ? []
        : ["its organization was deleted"]),
      ...((await count(`select count(*)::int as count from "user" where id = any($1)`, people)) ===
      people.length
        ? []
        : ["one of its people was deleted"]),
    ];
  });
}

async function markReady(demo: Demo, anchor: Date, handles: ClassroomHandles): Promise<Marker> {
  const rows = await withClient(
    databaseUrl(demo),
    async (client) =>
      (
        await client.query<Marker>(
          `update dev_demo.environment set state = 'ready', anchor = $2, handles = $3 where id = $1 returning id, worktree, storage, state, scenario, anchor, handles`,
          [demo.id, anchor, JSON.stringify(handles)],
        )
      ).rows,
  );
  if (rows.length !== 1) throw new DemoRefused(`${demo.database}'s marker is gone.`);
  return rows[0]!;
}
