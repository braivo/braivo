// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organization } from "@braivo/db/schema";
import {
  sharedDatabase,
  clearLearningData,
  seedOrganization,
  violatedConstraint,
} from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  createObjectives,
  findObjectivesOutsideOrganization,
  readObjectives,
} from "./objective.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "objective-test-org";
const otherOrganizationId = "objective-test-other-org";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

const organizationIds = [organizationId, otherOrganizationId];

/** Requires TEST_DATABASE_URL, since the point is that the schema really applies. */
describe.skipIf(!connectionString)("objectives", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    for (const id of organizationIds) {
      await seedOrganization(database, { organizationId: id, learnerIds: [], at: createdAt });
    }
  });

  beforeEach(async () => {
    for (const id of organizationIds) {
      await clearLearningData(database, id);
    }
  });

  test("returns generated IDs positionally matching the titles", async () => {
    const [pastTense, fractions] = await createObjectives(database, organizationId, [
      "Past tense",
      "Fractions",
    ]);

    expect(await readObjectives(database, organizationId)).toEqual([
      { id: fractions!, title: "Fractions" },
      { id: pastTense!, title: "Past tense" },
    ]);
  });

  test("gives two organizations their own objective for the same knowledge", async () => {
    // An objective ID is opaque precisely so that a content owner's naming is
    // never a claim on a title nobody else may use.
    const [mine] = await createObjectives(database, organizationId, ["Past tense"]);
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Past tense"]);

    expect(mine).not.toBe(theirs);
    expect(await readObjectives(database, organizationId)).toEqual([
      { id: mine!, title: "Past tense" },
    ]);
  });

  test("names objectives another organization owns, or nobody does", async () => {
    const [mine] = await createObjectives(database, organizationId, ["Past tense"]);
    const [theirs] = await createObjectives(database, otherOrganizationId, ["Fractions"]);

    expect(
      await findObjectivesOutsideOrganization(database, organizationId, [
        mine!,
        theirs!,
        "no-such-objective",
      ]),
    ).toEqual([theirs!, "no-such-objective"]);
  });

  test("creates nothing, and does not fail, for an empty list", async () => {
    expect(await createObjectives(database, organizationId, [])).toEqual([]);
    expect(await readObjectives(database, organizationId)).toEqual([]);
  });

  test("refuses objectives for an organization that does not exist", async () => {
    const error = await createObjectives(database, "no-such-organization", ["Past tense"]).catch(
      (thrown: unknown) => thrown,
    );

    expect(violatedConstraint(error)).toBe("objective_organization_id_organization_id_fk");
  });

  test("refuses to delete an organization that still owns objectives", async () => {
    await createObjectives(database, organizationId, ["Past tense"]);

    const error = await database
      .delete(organization)
      .where(eq(organization.id, organizationId))
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(error)).toBe("objective_organization_id_organization_id_fk");
  });
});
