// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createObjectives, createSource } from "../persistence/index.ts";
import {
  citeSources,
  InvalidCitation,
  listObjectiveCitations,
  type QuotedCitation,
} from "./citations.ts";
import { NotPermitted } from "./permission.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "citations-test-org";
const otherOrganizationId = "citations-test-other-org";
const author = "citations-test-author";
const learner = "citations-test-learner";
const at = new Date("2026-01-01T00:00:00.000Z");

/** A character outside the BMP first, so UTF-16 and code-point positions differ. */
const lesson = "🙂 Saludos\n\nHola significa hello.\nAdiós significa goodbye.\n";

let greetings!: string;
let farewells!: string;
let unit!: string;
let theirSource!: string;
let theirObjective!: string;

function cite(citations: QuotedCitation[], actingAs = author) {
  return citeSources({ database, organizationId, actingAs, citations });
}

function list(objectiveId: string, actingAs = author) {
  return listObjectiveCitations({ database, organizationId, actingAs, objectiveId });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("citing sources", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner],
      adminIds: [author],
      at,
    });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at,
    });

    [greetings, farewells] = (await createObjectives(database, organizationId, [
      "Greetings",
      "Farewells",
    ])) as [string, string];
    unit = await createSource(database, {
      organizationId,
      title: "Unidad 1",
      text: lesson,
      createdAt: at,
    });

    [theirObjective] = (await createObjectives(database, otherOrganizationId, ["Theirs"])) as [
      string,
    ];
    theirSource = await createSource(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      text: lesson,
      createdAt: at,
    });
  });

  test("locates each quote, stores it, and reads the passage back", async () => {
    const located = await cite([
      { objectiveId: greetings, sourceId: unit, quote: "Hola significa hello." },
      { objectiveId: farewells, sourceId: unit, quote: "Adiós significa\n goodbye." },
    ]);

    // The emoji is one position, not two.
    expect(located).toEqual([
      { objectiveId: greetings, sourceId: unit, start: 11, end: 32 },
      { objectiveId: farewells, sourceId: unit, start: 33, end: 57 },
    ]);
    // Cut out by PostgreSQL, whose count must agree with the one that located it.
    expect(await list(greetings)).toEqual([
      { sourceId: unit, start: 11, end: 32, quote: "Hola significa hello." },
    ]);
    expect(await list(farewells)).toMatchObject([{ quote: "Adiós significa goodbye." }]);
  });

  test("stores a repeated citation once", async () => {
    const citation = { objectiveId: greetings, sourceId: unit, quote: "Hola significa hello." };

    await cite([citation]);
    await cite([citation, citation]);

    expect(await list(greetings)).toHaveLength(1);
  });

  test("lets one objective cite several sources", async () => {
    const workbook = await createSource(database, {
      organizationId,
      title: "Cuaderno",
      text: "Ejercicio: di hola a tu compañero.",
      createdAt: at,
    });

    await cite([
      { objectiveId: greetings, sourceId: unit, quote: "Hola significa hello." },
      { objectiveId: greetings, sourceId: workbook, quote: "di hola" },
    ]);

    expect((await list(greetings))?.map((passage) => passage.sourceId).toSorted()).toEqual(
      [unit, workbook].toSorted(),
    );
  });

  test.each([
    ["missing", "Buenos días", /does not occur/],
    ["ambiguous", "significa", /more than once/],
    ["blank", "  ", /blank/],
  ])(
    "refuses a %s quote by its position in the batch, storing nothing",
    async (_label, quote, reason) => {
      const refused = cite([
        { objectiveId: greetings, sourceId: unit, quote: "Hola significa hello." },
        { objectiveId: farewells, sourceId: unit, quote },
      ]);

      await expect(refused).rejects.toBeInstanceOf(InvalidCitation);
      await expect(refused).rejects.toThrow(/^Citation 1: /);
      await expect(refused).rejects.toThrow(reason);
      expect(await list(greetings)).toEqual([]);
    },
  );

  test("refuses another organization's objective or source, and one that does not exist", async () => {
    const quote = "Hola significa hello.";

    for (const citation of [
      { objectiveId: theirObjective, sourceId: unit, quote },
      { objectiveId: greetings, sourceId: theirSource, quote },
      { objectiveId: "no-such-objective", sourceId: unit, quote },
      { objectiveId: greetings, sourceId: "no-such-source", quote },
    ]) {
      await expect(cite([citation])).rejects.toBeInstanceOf(NotPermitted);
    }
    expect(await list(greetings)).toEqual([]);
  });

  test("refuses a learner citing or reading citations", async () => {
    await expect(
      cite([{ objectiveId: greetings, sourceId: unit, quote: "Hola" }], learner),
    ).rejects.toBeInstanceOf(NotPermitted);
    await expect(list(greetings, learner)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("answers another organization's objective as one that does not exist", async () => {
    expect(await list(theirObjective)).toBeUndefined();
    expect(await list("no-such-objective")).toBeUndefined();
  });
});
