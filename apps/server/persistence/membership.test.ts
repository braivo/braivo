// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { member, user } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase, violatedConstraint } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { readOrganizationRoles } from "./membership.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "membership-test-org";
const otherOrganizationId = "membership-test-other-org";
const learner = "membership-test-learner";
const outsider = "membership-test-outsider";
const at = new Date("2026-01-01T00:00:00.000Z");

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("organization membership", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds: [learner], at });
    await seedOrganization(database, { organizationId: otherOrganizationId, learnerIds: [], at });
    await database
      .insert(user)
      .values({
        id: outsider,
        name: outsider,
        email: `${outsider}@example.com`,
        emailVerified: false,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing();
  });

  test("reports the role a member holds", async () => {
    expect(await readOrganizationRoles(database, { organizationId, userId: learner })).toEqual([
      "member",
    ]);
  });

  test("reports each role of a member who holds several", async () => {
    const rolesOrganizationId = "membership-test-roles-org";
    await seedOrganization(database, {
      organizationId: rolesOrganizationId,
      learnerIds: [learner],
      at,
    });
    // How Better Auth stores them: one row, one comma-separated string.
    await database
      .update(member)
      .set({ role: "member,admin" })
      .where(eq(member.organizationId, rolesOrganizationId));

    expect(
      await readOrganizationRoles(database, {
        organizationId: rolesOrganizationId,
        userId: learner,
      }),
    ).toEqual(["member", "admin"]);
  });

  test("reports nothing for someone who belongs to no organization", async () => {
    expect(await readOrganizationRoles(database, { organizationId, userId: outsider })).toEqual([]);
  });

  test("does not carry membership across organizations", async () => {
    // The learner is a member, just not of this one — the case a check that only
    // asked "is this user a member of anything" would wave through.
    expect(
      await readOrganizationRoles(database, {
        organizationId: otherOrganizationId,
        userId: learner,
      }),
    ).toEqual([]);
  });

  test("refuses a second membership for the same user and organization", async () => {
    // Better Auth places no uniqueness here, and two invitation acceptances that
    // race can each create one. This role read takes the first row it finds, so
    // a duplicate means removing someone leaves their access behind — a removed
    // administrator still passing every check Braivo makes.
    const error = await database
      .insert(member)
      .values({
        id: `${organizationId}:duplicate`,
        organizationId,
        userId: learner,
        role: "admin",
        createdAt: at,
      })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("member_organization_user_uidx");
    expect(await readOrganizationRoles(database, { organizationId, userId: learner })).toEqual([
      "member",
    ]);
  });

  test("reports nothing for a user who does not exist", async () => {
    expect(
      await readOrganizationRoles(database, { organizationId, userId: "no-such-user" }),
    ).toEqual([]);
  });

  test("seeds exactly the memberships asked for, whatever an earlier run left", async () => {
    const fixture = "membership-test-fixture-org";
    const person = "membership-test-fixture-person";
    const leaver = "membership-test-fixture-leaver";
    const role = (userId: string) =>
      readOrganizationRoles(database, { organizationId: fixture, userId });

    // Listed as both: the admin role wins.
    await seedOrganization(database, {
      organizationId: fixture,
      learnerIds: [person, leaver],
      adminIds: [person],
      at,
    });
    expect(await role(person)).toEqual(["admin"]);
    expect(await role(leaver)).toEqual(["member"]);

    // Seeded again without the leaver and as a learner only: neither the admin
    // role nor the leaver's membership survives.
    await seedOrganization(database, { organizationId: fixture, learnerIds: [person], at });
    expect(await role(person)).toEqual(["member"]);
    expect(await role(leaver)).toEqual([]);
  });
});
