// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createSource, readSources } from "./source.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

const organizationId = "source-test-org";
const otherOrganizationId = "source-test-other-org";
const at = new Date("2026-06-01T00:00:00.000Z");

const lesson = {
  title: "Los saludos",
  text: "¡Hola! 🙂 ¿Qué tal?\nAdiós.",
  url: "https://www.youtube.com/watch?v=abc123",
  language: "es",
};

const add = (fields: Partial<typeof lesson> = {}, organization = organizationId) =>
  createSource(database, { organizationId: organization, ...lesson, ...fields, createdAt: at });

/** Requires TEST_DATABASE_URL: the point is which rows the database holds. */
describe.skipIf(!connectionString)("storing sources", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  beforeEach(async () => {
    await testing.seedOrganization(database, { organizationId, learnerIds: [], at });
    await testing.seedOrganization(database, {
      organizationId: otherOrganizationId,
      learnerIds: [],
      at,
    });
  });

  test("returns the source already there rather than storing it twice", async () => {
    const first = await add();
    const again = await add();

    expect(again).toBe(first);
    expect(await readSources(database, organizationId)).toHaveLength(1);
  });

  test("gives two writers racing to add the same source the one row", async () => {
    const ids = await Promise.all([add(), add(), add()]);

    expect(new Set(ids).size).toBe(1);
    expect(await readSources(database, organizationId)).toHaveLength(1);
  });

  test.each([
    ["another title", { title: "Saludos" }],
    ["another text", { text: "¡Hola!" }],
    ["another link", { url: "https://www.youtube.com/watch?v=xyz789" }],
    ["no link", { url: undefined }],
    ["another language", { language: "es-MX" }],
  ])("keeps a source with %s as a source of its own", async (_label, fields) => {
    expect(await add(fields)).not.toBe(await add());
  });

  test("keeps each organization's copy to itself", async () => {
    expect(await add({}, otherOrganizationId)).not.toBe(await add());
  });
});
