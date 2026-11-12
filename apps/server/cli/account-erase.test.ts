// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import {
  account,
  appleLink,
  learnerSignInCode,
  member,
  organization,
  user,
  verification,
} from "@braivo/db/schema";
import { clearLearningData, sharedDatabase } from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { uploadFile } from "../application/files.ts";
import { setUpPersonalOrganization } from "../application/organizations.ts";
import { directoryStore } from "../storage/index.ts";

// The operator's command against a real database (access-49): what it says and
// asks before anything is erased. What erasing removes is
// `persistence/learner-data-inventory.test.ts`'s.

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const prefix = "account-erase-cli-test";
const fernwood = `${prefix}-fernwood`;
const ada = { id: `${prefix}-ada`, name: "Ada Fernley", email: `${prefix}-ada@fernwood.example` };
const at = new Date("2026-09-01T08:00:00.000Z");
const key = "erasure-log-test-key-that-is-long-enough";

let logDirectory = "";
let filesDirectory = "";

async function run(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: connectionString ?? "",
      BRAIVO_ERASURE_LOG: logDirectory,
      BRAIVO_ERASURE_LOG_HMAC_KEY: key,
      BRAIVO_FILES: filesDirectory,
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

const erase = (...more: string[]) => ["account", "erase", "--email", ada.email, ...more];
const accounts = () => database.$count(user, eq(user.id, ada.id));

async function clear() {
  const owned = await database
    .select({ id: organization.id })
    .from(organization)
    .innerJoin(user, eq(user.id, organization.personalOwnerId))
    .where(eq(user.email, ada.email));
  for (const { id } of owned) await clearLearningData(database, id);
  await database.delete(organization).where(
    inArray(
      organization.id,
      owned.map(({ id }) => id),
    ),
  );
  await database.delete(user).where(eq(user.email, ada.email));
  await database.delete(appleLink).where(eq(appleLink.email, ada.email));
  await database.delete(learnerSignInCode).where(eq(learnerSignInCode.organizationId, fernwood));
  await database.delete(organization).where(eq(organization.id, fernwood));
}

// Each test runs the CLI as several processes in turn: past the default timeout while the whole
// suite loads the machine.
describe.skipIf(!connectionString)("account erase", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
    logDirectory = await mkdtemp(join(tmpdir(), `${prefix}-log-`));
    if (filesDirectory) await rm(filesDirectory, { recursive: true, force: true });
    filesDirectory = await mkdtemp(join(tmpdir(), `${prefix}-files-`));
    await database
      .insert(user)
      .values({ ...ada, emailVerified: true, createdAt: at, updatedAt: at });
    await database
      .insert(organization)
      .values({ id: fernwood, name: "Fernwood School", slug: fernwood, createdAt: at });
    await database.insert(member).values({
      id: `${prefix}-m1`,
      organizationId: fernwood,
      userId: ada.id,
      role: "member",
      createdAt: at,
    });
  });

  afterAll(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
    if (filesDirectory) await rm(filesDirectory, { recursive: true, force: true });
  });

  test("shows the installation, account, schools, and counts, and needs the email typed back", async () => {
    const wrong = await run(erase(), { stdin: "not-the-email\n" });
    expect(wrong.code).toBe(1);
    const { host, pathname } = new URL(connectionString ?? "");
    expect(wrong.stdout).toContain(`${host}${pathname}`);
    expect(wrong.stdout).toContain(ada.email);
    expect(wrong.stdout).toContain(ada.id);
    expect(wrong.stdout).toContain(fernwood);
    expect(wrong.stdout).toContain("memberships 1");
    expect(wrong.stderr).toContain("Nothing was erased");
    expect(await accounts()).toBe(1);
    expect(await readdir(logDirectory)).toEqual([]);

    // Input ended without an answer, as with no terminal: never a yes.
    const silent = await run(erase(), { stdin: "" });
    expect(silent.code).toBe(1);
    expect(await accounts()).toBe(1);

    const typed = await run(erase(), { stdin: `${ada.email}\n` });
    expect(typed.code, typed.stderr).toBe(0);
    expect(typed.stdout).toContain("Erased:");
    expect(await accounts()).toBe(0);
  });

  test("tells the person to remove the app at Apple when no Apple token it could revoke is kept (ADR 0062)", async () => {
    const plain = await run(erase("--yes"));
    expect(plain.stdout).not.toContain("Apple:");

    await database
      .insert(user)
      .values({ ...ada, emailVerified: true, createdAt: at, updatedAt: at });
    await database.insert(account).values({
      id: `${prefix}-apple`,
      accountId: `${prefix}-apple-subject`,
      providerId: "apple",
      userId: ada.id,
      createdAt: at,
      updatedAt: at,
    });
    const withApple = await run(erase("--yes"));
    expect(withApple.code, withApple.stderr).toBe(0);
    expect(withApple.stdout).toContain(
      "Apple:        not revoked. Tell the person to remove the app under Sign in with Apple",
    );
    expect(await accounts()).toBe(0);
  });

  test("an Apple link waiting for a code to the address is erased with no account, and counted", async () => {
    await database.delete(user).where(eq(user.id, ada.id));
    await database.insert(appleLink).values({
      idHash: `${prefix}-link`,
      email: ada.email,
      subject: `${prefix}-subject`,
      name: "",
      expiresAt: new Date(Date.now() + 600_000),
    });
    const done = await run(erase("--yes"));

    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).not.toContain("Nothing to erase");
    expect(done.stdout).toContain("Apple links 1");
    // Its authorization cannot be revoked here (no secret, no Apple key): said so.
    expect(done.stdout).toContain("Apple:        not revoked.");
    expect(await database.$count(appleLink, eq(appleLink.email, ada.email))).toBe(0);
  });

  test("--yes needs no answer, the log record is private and done, and a second run changes nothing", async () => {
    const done = await run(erase("--yes"));
    expect(done.code, done.stderr).toBe(0);
    expect(await accounts()).toBe(0);

    const [name, ...more] = await readdir(logDirectory);
    expect(more).toEqual([]);
    const path = join(logDirectory, name!);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      scope: "account",
      userId: ada.id,
      doneAt: expect.any(String),
    });
    expect(done.stdout).toContain(String(record.id));
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const again = await run(erase());
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("No account has");
    expect(again.stdout).toContain("Nothing to erase");
    expect(await readdir(logDirectory)).toEqual([name]);
  });

  test("rows naming an address with no account are shown and removed, confirmed the same way", async () => {
    await run(erase("--yes"));
    const later = new Date(Date.now() + 600_000);
    await database.insert(learnerSignInCode).values({
      hostname: "fernwood.example",
      email: ada.email,
      organizationId: fernwood,
      codeSeed: "seed",
      expiresAt: later,
      resendAt: later,
    });
    const refused = await run(erase(), { stdin: "\n" });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("No account has");
    expect(refused.stdout).toContain("sign-in codes 1");
    const done = await run(erase("--yes"));
    expect(done.code, done.stderr).toBe(0);
    expect(await database.$count(learnerSignInCode, eq(learnerSignInCode.email, ada.email))).toBe(
      0,
    );
  });

  test("a blank address names nobody: neither another's empty row nor an ended input", async () => {
    // Another person's resend cooldown, whose value is empty.
    const cooldown = `sign-in-code-sent:${prefix}-bea@fernwood.example`;
    await database.delete(verification).where(eq(verification.id, cooldown));
    await database.insert(verification).values({
      id: cooldown,
      identifier: cooldown,
      value: "",
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: at,
      updatedAt: at,
    });
    for (const more of [[], ["--yes"]]) {
      const blank = await run(["account", "erase", "--email", " ", ...more]);
      expect(blank.code).toBe(1);
      expect(blank.stdout).not.toContain("Erased:");
    }
    expect(await database.$count(verification, eq(verification.id, cooldown))).toBe(1);
    expect(await readdir(logDirectory)).toEqual([]);
    await database.delete(verification).where(eq(verification.id, cooldown));
  });

  test("refuses, erasing nothing: no log configured, or an only owner", async () => {
    const unset = await run(erase("--yes"), { env: { BRAIVO_ERASURE_LOG: "" } });
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain("BRAIVO_ERASURE_LOG");
    const noKey = await run(erase("--yes"), { env: { BRAIVO_ERASURE_LOG_HMAC_KEY: "" } });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("BRAIVO_ERASURE_LOG_HMAC_KEY");
    expect((await run(["account", "erase"])).code).toBe(1);

    await database.update(member).set({ role: "owner" }).where(eq(member.userId, ada.id));
    const owner = await run(erase("--yes"));
    expect(owner.code).toBe(1);
    expect(owner.stderr).toContain("only owner");
    expect(await accounts()).toBe(1);
    expect(await readdir(logDirectory)).toEqual([]);
  });

  test("erases their personal organization and its files, finishing a pending one first, and asks afresh after", async () => {
    const { organization: own } = await setUpPersonalOrganization({
      database,
      actingAs: ada.id,
      now: at,
    });
    const files = directoryStore(filesDirectory);
    await uploadFile({
      database,
      files,
      organizationId: own.id,
      actingAs: ada.id,
      bytes: new TextEncoder().encode("%PDF-1.7 Ada's"),
      contentType: "application/pdf",
      now: new Date(),
    });
    // Where its bytes are, made unwritable so none can be unlinked.
    const stored = join(filesDirectory, "organizations", own.id, "files");

    const shown = await run(erase(), { stdin: "\n" });
    expect(shown.stdout).toContain(
      `Personal:     ${own.slug} (${own.id}), erased with the account`,
    );
    expect(shown.stdout).toContain("files 1");
    expect(shown.stdout).not.toContain(`School:       ${own.slug}`);

    // Its files cannot be deleted: the rows go, the bytes stay, the record
    // pending. Apple's outcome is said all the same, its link gone with the
    // account: nothing could say it again.
    await database.insert(account).values({
      id: `${prefix}-apple`,
      accountId: `${prefix}-apple-subject`,
      providerId: "apple",
      userId: ada.id,
      createdAt: at,
      updatedAt: at,
    });
    await chmod(stored, 0o555);
    const failed = await run(erase("--yes")).finally(() => chmod(stored, 0o755));
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(
      "Apple:        not revoked. Tell the person to remove the app under Sign in with Apple",
    );
    const [, recordId] = /Log record (\S+) is pending; run this command again/.exec(failed.stderr)!;
    expect(await accounts()).toBe(0);
    expect(await database.$count(organization, eq(organization.id, own.id))).toBe(0);
    expect(await files.list(`organizations/${own.id}`)).toHaveLength(1);

    // The address registers again before the next run, which finishes Ada's and
    // then asks about this account, --yes or not; unanswered, it keeps it.
    const later = { id: `${prefix}-later`, name: "Ada Again", email: ada.email };
    await database
      .insert(user)
      .values({ ...later, emailVerified: true, createdAt: at, updatedAt: at });
    const again = await run(erase("--yes"), { stdin: "" });
    expect(again.stdout).toContain(`Pending:      log record ${recordId}: it committed; now done`);
    expect(again.stdout).toContain(`files of ${own.id} deleted`);
    expect(again.stdout).toContain(`Account:      ${ada.email} (${later.id})`);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Not confirmed. Nothing was erased.");
    expect(await files.list(`organizations/${own.id}`)).toEqual([]);
    expect(await database.$count(user, eq(user.id, later.id))).toBe(1);
    const record = JSON.parse(await readFile(join(logDirectory, `${recordId}.json`), "utf8"));
    expect(record).toMatchObject({ personalOrganizationId: own.id, doneAt: expect.any(String) });
  });
});
