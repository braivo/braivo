// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@braivo/db";
import { member, organization, user } from "@braivo/db/schema";
import { sharedDatabase } from "@braivo/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

// The operator's way out of the only-owner refusal (access-58): what it says and
// asks, what it refuses, and that an erasure refused before then goes through.

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const prefix = "make-owner-cli-test";
const fernwood = `${prefix}-fernwood`;
const ada = { id: `${prefix}-ada`, name: "Ada Fernley", email: `${prefix}-ada@fernwood.example` };
const ben = { id: `${prefix}-ben`, name: "Ben Fernley", email: `${prefix}-ben@fernwood.example` };
const cleo = { id: `${prefix}-cleo`, name: "Cleo Oak", email: `${prefix}-cleo@fernwood.example` };
const at = new Date("2026-09-01T08:00:00.000Z");

let logDirectory = "";

async function run(args: readonly string[], stdin = "") {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: connectionString ?? "",
      BRAIVO_ERASURE_LOG: logDirectory,
      BRAIVO_ERASURE_LOG_HMAC_KEY: "erasure-log-test-key-that-is-long-enough",
    },
    stdin: new Blob([stdin]),
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

const makeOwner = (email: string, ...more: string[]) =>
  ["organization", "make-owner", "--slug", fernwood, "--email", email, ...more] as const;

async function roleOf(userId: string) {
  const [row] = await database
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, fernwood), eq(member.userId, userId)));
  return row?.role;
}

async function clear() {
  await database.delete(user).where(inArray(user.id, [ada.id, ben.id, cleo.id]));
  await database.delete(organization).where(eq(organization.id, fernwood));
}

// CLI subprocesses need extra time under the whole suite's load.
describe.skipIf(!connectionString)("organization make-owner", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
    logDirectory = await mkdtemp(join(tmpdir(), `${prefix}-log-`));
    await database.insert(user).values(
      [ada, ben, cleo].map((person) => ({
        ...person,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await database
      .insert(organization)
      .values({ id: fernwood, name: "Fernwood School", slug: fernwood, createdAt: at });
    await database.insert(member).values(
      [
        { userId: ada.id, role: "owner" },
        { userId: ben.id, role: "member" },
      ].map((row) => ({ ...row, id: row.userId, organizationId: fernwood, createdAt: at })),
    );
  });

  afterAll(async () => {
    await clear();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
  });

  test("an only owner refused erasure goes through once another member is made owner", async () => {
    const erase = ["account", "erase", "--email", ada.email, "--yes"];
    const refused = await run(erase);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("only owner");
    expect(refused.stderr).toContain(fernwood);
    expect(refused.stderr).toContain("organization make-owner");
    const ending = await run([
      "learner",
      "erase-history",
      "--email",
      ada.email,
      "--organization",
      fernwood,
      "--end-membership",
      "--yes",
    ]);
    expect(ending.code).toBe(1);
    expect(ending.stderr).toContain("organization make-owner");

    const made = await run(makeOwner(ben.email, "--yes"));
    expect(made.code, made.stderr).toBe(0);
    expect(await roleOf(ben.id)).toBe("owner");
    expect(await roleOf(ada.id)).toBe("owner");

    const erased = await run(erase);
    expect(erased.code, erased.stderr).toBe(0);
    expect(await roleOf(ada.id)).toBeUndefined();
    expect(await roleOf(ben.id)).toBe("owner");
  });

  test("shows what it will do and that it cannot be undone here, and needs the slug typed back", async () => {
    const wrong = await run(makeOwner(ben.email), "not-the-slug\n");
    expect(wrong.code).toBe(1);
    const { host, pathname } = new URL(connectionString ?? "");
    expect(wrong.stdout).toContain(`${host}${pathname}`);
    expect(wrong.stdout).toContain("Fernwood School");
    expect(wrong.stdout).toContain(fernwood);
    expect(wrong.stdout).toContain(ben.email);
    expect(wrong.stdout).toContain(ben.id);
    expect(wrong.stdout).toContain("member");
    expect(wrong.stdout).toContain("delete the organization");
    expect(wrong.stdout).toContain("cannot be undone");
    expect(wrong.stderr).toContain("Nothing was changed");
    expect(await roleOf(ben.id)).toBe("member");

    // Input ended without an answer, as with no terminal: never a yes.
    const silent = await run(makeOwner(ben.email));
    expect(silent.code).toBe(1);
    expect(await roleOf(ben.id)).toBe("member");

    const typed = await run(makeOwner(` ${ben.email.toUpperCase()} `), `${fernwood}\n`);
    expect(typed.code, typed.stderr).toBe(0);
    expect(await roleOf(ben.id)).toBe("owner");
  });

  test("an owner already, whatever else they hold, says so and changes nothing, unasked", async () => {
    await database.update(member).set({ role: "owner,admin" }).where(eq(member.userId, ada.id));
    const again = await run(makeOwner(ada.email));
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("already");
    expect(await roleOf(ada.id)).toBe("owner,admin");
  });

  test("refuses, changing nothing: no such organization or account, a blank address, or a non-member", async () => {
    const elsewhere = ["organization", "make-owner", "--slug", `${prefix}-none`];
    const noSchool = await run([...elsewhere, "--email", ben.email, "--yes"]);
    expect(noSchool.code).toBe(1);
    expect(noSchool.stderr).toContain("No organization");

    const noAccount = await run(makeOwner(`${prefix}-nobody@fernwood.example`, "--yes"));
    expect(noAccount.code).toBe(1);
    expect(noAccount.stderr).toContain("No account");

    expect((await run(makeOwner(" ", "--yes"))).code).toBe(1);
    expect((await run(["organization", "make-owner", "--slug", fernwood])).code).toBe(1);

    const outsider = await run(makeOwner(cleo.email, "--yes"));
    expect(outsider.code).toBe(1);
    expect(outsider.stderr).toContain("not a member");
    expect(await roleOf(cleo.id)).toBeUndefined();
    expect(await roleOf(ben.id)).toBe("member");
  });
});
