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

import { ConflictingKey } from "./key.ts";
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

  describe("under the caller's keys", () => {
    test("returns the objective a key already names, as a retry needs", async () => {
      const [first] = await createObjectives(database, organizationId, [
        { title: "Greetings", key: "es-greetings" },
      ]);
      const again = await createObjectives(database, organizationId, [
        { title: "Greetings", key: "es-greetings" },
        "Unkeyed",
      ]);

      expect(again[0]).toBe(first);
      expect(await readObjectives(database, organizationId)).toHaveLength(2);
    });

    test("refuses the whole batch over a key naming another title, storing nothing", async () => {
      await createObjectives(database, organizationId, [{ title: "Greetings", key: "greetings" }]);

      const refused = createObjectives(database, organizationId, [
        { title: "Numbers", key: "numbers" },
        { title: "Saludos", key: "greetings" },
      ]);

      await expect(refused).rejects.toBeInstanceOf(ConflictingKey);
      await expect(refused).rejects.toThrow(/^Objective 1 has key "greetings"/);
      expect((await readObjectives(database, organizationId)).map((row) => row.title)).toEqual([
        "Greetings",
      ]);
    });

    test("reads a key repeated within a batch as one objective, on the same terms", async () => {
      const [one, two] = await createObjectives(database, organizationId, [
        { title: "Greetings", key: "greetings" },
        { title: "Greetings", key: "greetings" },
      ]);
      expect(two).toBe(one);

      await expect(
        createObjectives(database, organizationId, [
          { title: "Colors", key: "colors" },
          { title: "Colours", key: "colors" },
        ]),
      ).rejects.toBeInstanceOf(ConflictingKey);
    });

    test("lets each organization use a key of its own, and writers racing on one share it", async () => {
      const [ours] = await createObjectives(database, organizationId, [
        { title: "Greetings", key: "greetings" },
      ]);
      const [theirs] = await createObjectives(database, otherOrganizationId, [
        { title: "Greetings", key: "greetings" },
      ]);
      expect(theirs).not.toBe(ours);

      const raced = await Promise.all(
        Array.from({ length: 4 }, () =>
          createObjectives(database, organizationId, [{ title: "Numbers", key: "numbers" }]),
        ),
      );
      expect(new Set(raced.flat()).size).toBe(1);
    });

    test("lets batches naming the same new keys in opposite orders race without deadlock", async () => {
      // Each would otherwise insert its first key, then wait on the other's.
      const a = { title: "A", key: "race-a" };
      const b = { title: "B", key: "race-b" };

      const raced = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          createObjectives(database, organizationId, index % 2 === 0 ? [a, b] : [b, a]),
        ),
      );

      const [ab, ba] = [raced[0]!, raced[1]!];
      expect(ba).toEqual([ab[1], ab[0]]);
      expect(new Set(raced.flat()).size).toBe(2);
    });
  });
});
