// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import type { Model } from "../ai/index.ts";
import { listOrganizations } from "./organizations.ts";
import {
  assertMayAdminister,
  assertMayAuthor,
  isMember,
  mayAdminister,
  mayAuthor,
  NotPermitted,
} from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "permission-test-org";
const plainMember = "permission-test-member";
/** Seeded as `member`, then given `admin` too, stored as Better Auth does: `member,admin`. */
const memberAndAdmin = "permission-test-member-and-admin";
/** Given `author` alone (ADR 0048). */
const author = "permission-test-author";
const at = new Date("2026-01-01T00:00:00.000Z");

/** Requires TEST_DATABASE_URL: the roles read are the database's, as stored. */
describe.skipIf(!connectionString)("permission", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, {
      organizationId,
      learnerIds: [plainMember, memberAndAdmin, author],
      at,
    });
    await database
      .update(member)
      .set({ role: "member,admin" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, memberAndAdmin)));
    await database
      .update(member)
      .set({ role: "author" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, author)));
  });

  test("lets an `author` author, not administer, and an `admin` do both", async () => {
    const asAuthor = { organizationId, userId: author };
    expect(await mayAuthor(database, asAuthor)).toBe(true);
    await expect(assertMayAuthor(database, asAuthor)).resolves.toBeUndefined();
    expect(await mayAdminister(database, asAuthor)).toBe(false);
    await expect(assertMayAdminister(database, asAuthor)).rejects.toBeInstanceOf(NotPermitted);
    // A member too: any role is membership.
    expect(await isMember(database, asAuthor)).toBe(true);

    expect(await mayAuthor(database, { organizationId, userId: memberAndAdmin })).toBe(true);
    expect(await mayAuthor(database, { organizationId: "another-org", userId: author })).toBe(
      false,
    );
  });

  test("lets a member who also holds `admin` administer", async () => {
    const input = { organizationId, userId: memberAndAdmin };
    expect(await mayAdminister(database, input)).toBe(true);
    await expect(assertMayAdminister(database, input)).resolves.toBeUndefined();

    const managed = await listOrganizations({ database, actingAs: memberAndAdmin });
    expect(managed.map((organization) => organization.id)).toEqual([organizationId]);
  });

  test("says whether an organization authored in may use the installation's AI", async () => {
    const model = {} as Model;
    const ai = async (ai?: Parameters<typeof listOrganizations>[0]["ai"]) =>
      (await listOrganizations({ database, actingAs: memberAndAdmin, ai }))[0]!.aiEnabled;

    expect(await ai()).toBe(false);
    expect(await ai({ model, organizations: "all" })).toBe(true);
    expect(await ai({ model, organizations: new Set([organizationId]) })).toBe(true);
    expect(await ai({ model, organizations: new Set(["another-org"]) })).toBe(false);
    // A monthly limit leaves it on: requests renew, and one past the limit says when.
    expect(await ai({ model, organizations: "all", monthlyLimit: 1 })).toBe(true);
  });

  test("refuses a member who holds no other role", async () => {
    const input = { organizationId, userId: plainMember };
    expect(await mayAdminister(database, input)).toBe(false);
    await expect(assertMayAdminister(database, input)).rejects.toBeInstanceOf(NotPermitted);
    expect(await mayAuthor(database, input)).toBe(false);
    await expect(assertMayAuthor(database, input)).rejects.toBeInstanceOf(NotPermitted);
    // Still a member, so the refusal is the role's.
    expect(await isMember(database, input)).toBe(true);

    expect(await listOrganizations({ database, actingAs: plainMember })).toEqual([]);
  });
});
