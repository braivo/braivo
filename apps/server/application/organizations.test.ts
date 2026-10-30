// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member, organization, user } from "@braivo/db/schema/auth";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { AccessKind } from "./access.ts";
import { registerLearnDomain } from "./domains.ts";
import { defineGroup } from "./groups.ts";
import {
  NameRefused,
  readToolsReadLearnerData,
  renameOrganization,
  SetUpRefused,
  setToolsReadLearnerData,
  setUpOrganization,
} from "./organizations.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");
const at = new Date("2026-06-01T00:00:00.000Z");

describe.skipIf(!connectionString)("setting up an organization", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  // Over HTTP one account's requests happen not to interleave, so this makes
  // them: each creates only once both have passed the first check.
  test("never leaves one account owning two, however its setups interleave", async () => {
    const userId = `setup-race-${crypto.randomUUID()}`;
    await database
      .insert(user)
      .values({ id: userId, name: "Racer", email: `${userId}@example.com`, createdAt: at });
    let waiting = 2;
    let bothChecked!: () => void;
    const checked = new Promise<void>((resolve) => (bothChecked = resolve));

    const setUp = (slug: string) =>
      setUpOrganization({
        database,
        baseUrl: "https://braivo.example",
        selfServeDomain: "braivo.example",
        actingAs: userId,
        name: slug,
        slug,
        create: async ({ name, ownerId }) => {
          if (--waiting === 0) bothChecked();
          await checked;
          const id = crypto.randomUUID();
          await database.insert(organization).values({ id, name, slug, createdAt: at });
          await database.insert(member).values({
            id: crypto.randomUUID(),
            organizationId: id,
            userId: ownerId,
            role: "owner",
            createdAt: at,
          });
          return { id, name, slug };
        },
      });

    const settled = await Promise.allSettled([setUp(`${userId}-a`), setUp(`${userId}-b`)]);

    const owned = await database.select().from(member).where(eq(member.userId, userId));
    expect(owned.length).toBeLessThanOrEqual(1);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(owned.length);
    for (const result of settled) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(SetUpRefused);
    }
  });

  test("undoes its organization when another takes the address before it registers", async () => {
    const userId = `setup-domain-${crypto.randomUUID()}`;
    await database
      .insert(user)
      .values({ id: userId, name: "Late", email: `${userId}@example.com`, createdAt: at });
    const other = `other-${crypto.randomUUID()}`;
    await database
      .insert(organization)
      .values({ id: other, name: "Other", slug: other, createdAt: at });
    const slug = `late-${crypto.randomUUID().slice(0, 8)}`;
    let created = "";

    const setUp = setUpOrganization({
      database,
      baseUrl: "https://braivo.example",
      selfServeDomain: "braivo.example",
      actingAs: userId,
      name: "Late",
      slug,
      create: async ({ name, ownerId }) => {
        created = crypto.randomUUID();
        await database.insert(organization).values({ id: created, name, slug, createdAt: at });
        await database.insert(member).values({
          id: crypto.randomUUID(),
          organizationId: created,
          userId: ownerId,
          role: "owner",
          createdAt: at,
        });
        // The operator registers the hostname for another meanwhile.
        await registerLearnDomain({
          database,
          baseUrl: "https://braivo.example",
          organizationSlug: other,
          hostname: `${slug}.braivo.example`,
        });
        return { id: created, name, slug };
      },
    });

    await expect(setUp).rejects.toThrow(`${slug}.braivo.example is taken`);
    expect(await database.select().from(organization).where(eq(organization.id, created))).toEqual(
      [],
    );
  });
  test("undoes its organization when registering the address fails", async () => {
    const userId = `setup-failed-${crypto.randomUUID()}`;
    await database
      .insert(user)
      .values({ id: userId, name: "Unlucky", email: `${userId}@example.com`, createdAt: at });
    let created = "";

    const setUp = setUpOrganization({
      database,
      baseUrl: "https://braivo.example",
      selfServeDomain: "braivo.example",
      actingAs: userId,
      name: "Unlucky",
      slug: `unlucky-${crypto.randomUUID().slice(0, 8)}`,
      create: async ({ name, slug, ownerId }) => {
        created = crypto.randomUUID();
        await database.insert(organization).values({ id: created, name, slug, createdAt: at });
        await database.insert(member).values({
          id: crypto.randomUUID(),
          organizationId: created,
          userId: ownerId,
          role: "owner",
          createdAt: at,
        });
        // A slug Postgres cannot read, standing in for the database failing.
        return { id: created, name, slug: `${slug}\u0000` };
      },
    });

    await expect(setUp).rejects.not.toBeInstanceOf(SetUpRefused);
    expect(await database.select().from(organization).where(eq(organization.id, created))).toEqual(
      [],
    );
    expect(await database.select().from(member).where(eq(member.userId, userId))).toEqual([]);
  });
});

describe.skipIf(!connectionString)("renaming an organization", () => {
  const organizationId = "rename-test-school";
  const admin = "rename-test-admin";
  const learner = "rename-test-learner";

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  const nameOf = async () =>
    (await database.select().from(organization).where(eq(organization.id, organizationId)))[0]
      ?.name;
  const rename = (name: string, actingAs = admin) =>
    renameOrganization({ database, organizationId, actingAs, name });

  test("renames it, trimmed, for whoever administers it, and no one else", async () => {
    await seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [admin],
      at,
    });

    expect(await rename("  Fernwood Language School ")).toEqual({
      name: "Fernwood Language School",
    });
    expect(await nameOf()).toBe("Fernwood Language School");

    await expect(rename("Taken Over", learner)).rejects.toBeInstanceOf(NotPermitted);
    // Administering another organization is not enough.
    const otherAdmin = "rename-test-other-admin";
    await seedOrganization(database, {
      organizationId: "rename-test-other-school",
      learnerIds: [],
      adminIds: [otherAdmin],
      at,
    });
    await expect(rename("Taken Over", otherAdmin)).rejects.toBeInstanceOf(NotPermitted);
    expect(await nameOf()).toBe("Fernwood Language School");
  });

  test.each([
    ["blank", "   "],
    ["over 100 characters", "a".repeat(101)],
    // PostgreSQL's text cannot hold it: refused, not failing to store.
    ["holding NUL", "Fern\u0000wood"],
  ])("refuses a name %s, keeping the old one", async (_case, name) => {
    await seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [admin],
      at,
    });
    await rename("Fernwood");

    await expect(rename(name)).rejects.toBeInstanceOf(NameRefused);
    expect(await nameOf()).toBe("Fernwood");
    expect((await rename("a".repeat(100))).name).toHaveLength(100);
  });
});

describe.skipIf(!connectionString)("whether tools read an organization's learners' data", () => {
  const organizationId = "tools-setting-test-school";
  const owner = "tools-setting-test-owner";
  const admin = "tools-setting-test-admin";
  const author = "tools-setting-test-author";
  const teacher = "tools-setting-test-teacher";
  const learner = "tools-setting-test-learner";
  const stranger = "tools-setting-test-stranger";
  const later = new Date("2026-06-02T00:00:00.000Z");

  const read = (actingAs = admin, accessKind: AccessKind = "browser") =>
    readToolsReadLearnerData({ database, organizationId, actingAs, accessKind });
  const set = (allowed: boolean, actingAs = admin, now = at, accessKind: AccessKind = "browser") =>
    setToolsReadLearnerData({ database, organizationId, actingAs, accessKind, allowed, now });
  const roleOf = (userId: string, role: string) =>
    database
      .update(member)
      .set({ role })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));

  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await seedOrganization(database, {
      organizationId,
      learnerIds: [author, teacher, learner],
      adminIds: [owner, admin],
      at,
    });
    await roleOf(owner, "owner");
    await roleOf(author, "author");
    await defineGroup({
      database,
      organizationId,
      actingAs: admin,
      definition: { name: "7A", learnerIds: [learner], teacherIds: [teacher], courseIds: [] },
    });
    await seedOrganization(database, {
      organizationId: "tools-setting-test-other-school",
      learnerIds: [],
      adminIds: [stranger],
      at,
    });
  });

  test("is off, never changed, until an owner or admin changes it, recorded as theirs", async () => {
    expect(await read(owner)).toEqual({ allowed: false, changedBy: null, changedAt: null });

    expect(await set(true, owner)).toEqual({
      allowed: true,
      changedBy: { userId: owner, name: owner },
      changedAt: at,
    });
    expect(await set(false, admin, later)).toEqual({
      allowed: false,
      changedBy: { userId: admin, name: admin },
      changedAt: later,
    });
    expect(await read(owner)).toEqual(await read(admin));
  });

  test("keeps the record when set to the value it has", async () => {
    await set(true, owner);
    const recorded = { allowed: true, changedBy: { userId: owner, name: owner }, changedAt: at };

    expect(await set(true, admin, later)).toEqual(recorded);
    expect(await read()).toEqual(recorded);
  });

  test.each([
    ["an author", author],
    ["a teacher", teacher],
    ["a learner", learner],
    ["another organization's admin", stranger],
  ])("is neither read nor changed by %s", async (_case, actingAs) => {
    await expect(read(actingAs)).rejects.toBeInstanceOf(NotPermitted);
    await expect(set(true, actingAs)).rejects.toBeInstanceOf(NotPermitted);

    expect(await read()).toEqual({ allowed: false, changedBy: null, changedAt: null });
  });

  test("is neither read nor changed by a tool, even an owner's", async () => {
    await expect(read(owner, "tool")).rejects.toBeInstanceOf(NotPermitted);
    await expect(set(true, owner, at, "tool")).rejects.toBeInstanceOf(NotPermitted);

    expect(await read(owner)).toEqual({ allowed: false, changedBy: null, changedAt: null });
  });

  // Over HTTP two requests rarely meet at the row, so this makes them: both
  // wait on a lock held elsewhere, then go in turn.
  test("records one change when two turn it on at once", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const lock = database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select 1 from "organization" where "id" = ${organizationId} for update`,
      );
      locked();
      await released;
    });
    await holding;

    // Settled, not all: awaited in `finally`, neither rejection goes unhandled.
    const both = Promise.allSettled([set(true, owner, at), set(true, admin, later)]);
    let settled!: Awaited<typeof both>;
    try {
      // Released once both updates wait on the row, so each meets the other's.
      await vi.waitFor(
        async () => {
          const [row] = (
            await database.execute<{ count: string }>(
              sql`select count(*) as count from pg_stat_activity
                  where datname = current_database() and wait_event_type = 'Lock'
                    and query like 'update "organization"%'`,
            )
          ).rows;
          expect(Number(row?.count)).toBe(2);
        },
        { timeout: 5_000 },
      );
    } finally {
      release();
      await lock;
      settled = await both;
    }
    const [first, second] = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    expect(second).toEqual(first);
    expect([
      { allowed: true, changedBy: { userId: owner, name: owner }, changedAt: at },
      { allowed: true, changedBy: { userId: admin, name: admin }, changedAt: later },
    ]).toContainEqual(first);
    expect(await read()).toEqual(first);
  });

  test("keeps the value and the time once the account that changed it is gone", async () => {
    const departing = "tools-setting-test-departing";
    await seedOrganization(database, {
      organizationId,
      learnerIds: [author, teacher, learner],
      adminIds: [admin, departing],
      at,
    });
    await set(true, departing);

    await database.delete(user).where(eq(user.id, departing));

    expect(await read()).toEqual({ allowed: true, changedBy: null, changedAt: at });
  });
});
