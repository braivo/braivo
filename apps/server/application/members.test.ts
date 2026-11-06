// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member, user } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { previewOwnerPromotion, promoteToOwner } from "./members.ts";

// What may change while the operator reads make-owner's prompt, for as long as
// they like (access-58): the promotion is of whom they were shown, or none.

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "promote-owner-test";
const ada = "promote-owner-test-ada";
const email = `${ada}@example.com`;
const at = new Date("2026-06-01T00:00:00.000Z");

const shown = () => previewOwnerPromotion({ database, slug: organizationId, email });

describe.skipIf(!connectionString)("promoting a member to owner, once shown", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await database.delete(user).where(eq(user.id, `${ada}-again`));
    await seedOrganization(database, { organizationId, learnerIds: [ada], at });
  });

  test("someone who stopped being a member is refused, not told they are an owner", async () => {
    const target = await shown();
    await database.delete(member).where(eq(member.userId, ada));

    await expect(promoteToOwner({ database, target })).rejects.toThrow(/not a member/);
  });

  test("an account made since under the address is not who was shown, and stays as it is", async () => {
    const target = await shown();
    const again = `${ada}-again`;
    await database.delete(user).where(eq(user.id, ada));
    await seedOrganization(database, { organizationId, learnerIds: [again], at });
    await database.update(user).set({ email }).where(eq(user.id, again));

    await expect(promoteToOwner({ database, target })).rejects.toThrow(/not a member/);

    const [row] = await database
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, again));
    expect(row?.role).toBe("member");
  });
});
