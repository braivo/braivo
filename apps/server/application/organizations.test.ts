// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member, organization, user } from "@braivo/db/schema/auth";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "./domains.ts";
import {
  NameRefused,
  renameOrganization,
  SetUpRefused,
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
