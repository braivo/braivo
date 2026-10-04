// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createSource } from "../persistence/index.ts";
import { NotPermitted } from "./permission.ts";
import { addSource, getSource, InvalidSource, listSources } from "./sources.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");

/** Stands in for a query cache, recording what is read through it. */
const cachedStatements: string[] = [];
const cachedDatabase = testing.recordingDatabase(connectionString ?? "", cachedStatements);

const organizationId = "sources-test-org";
const otherOrganizationId = "sources-test-other-org";
/** An admin, and so someone who may add material. */
const author = "sources-test-author";
/** A member, and so someone who may only study. */
const learner = "sources-test-learner";
const at = new Date("2026-01-01T00:00:00.000Z");

function add(
  title: string,
  text: string,
  actingAs = author,
  origin: { url?: string; language?: string } = {},
) {
  return addSource({ database, organizationId, actingAs, title, text, ...origin, now: at });
}

function get(sourceId: string, actingAs = author) {
  return getSource({ database, cachedDatabase, organizationId, actingAs, sourceId });
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("adding sources", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  afterAll(async () => {
    await cachedDatabase.$client.end();
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
  });

  test("stores the text in its normalized form and reads it back whole", async () => {
    const id = await add("  Unidad 1  ", "# Saludos\r\n\r\nHola, café.");

    expect(await get(id)).toEqual({
      id,
      title: "Unidad 1",
      text: "# Saludos\n\nHola, café.",
      createdAt: at,
    });
  });

  test("lists sources by title, without their text", async () => {
    const second = await add("Unidad 2", "Números");
    const first = await add("Unidad 1", "Saludos");

    expect(await listSources({ database, organizationId, actingAs: author })).toEqual([
      { id: first, title: "Unidad 1", createdAt: at },
      { id: second, title: "Unidad 2", createdAt: at },
    ]);
  });

  test("keeps where a transcript came from and its language, canonical", async () => {
    const id = await add("Los saludos", "Hola, ¿qué tal?", author, {
      url: "https://www.YouTube.com/watch?v=abc123",
      language: "es-mx",
    });

    expect(await get(id)).toMatchObject({
      url: "https://www.youtube.com/watch?v=abc123",
      language: "es-MX",
    });
    expect(await listSources({ database, organizationId, actingAs: author })).toMatchObject([
      { id, url: "https://www.youtube.com/watch?v=abc123", language: "es-MX" },
    ]);
  });

  test.each([
    [
      "a link that is not http",
      { url: "javascript:alert(1)" },
      /url must be an http or https link/,
    ],
    ["a language that is not a tag", { language: "Spanish" }, /BCP 47 tag such as es/],
  ])("refuses %s, saying so, and stores nothing", async (_label, origin, reason) => {
    const refused = add("Unidad 1", "Hola", author, origin);
    await expect(refused).rejects.toBeInstanceOf(InvalidSource);
    await expect(refused).rejects.toThrow(reason);

    expect(await listSources({ database, organizationId, actingAs: author })).toEqual([]);
  });

  test("keeps a revision beside the original rather than replacing it", async () => {
    // Immutable: whatever cites the first text keeps meaning what it meant.
    const original = await add("Unidad 1", "Hola");
    const revised = await add("Unidad 1", "Hola y adiós");

    expect(revised).not.toBe(original);
    expect((await get(original))?.text).toBe("Hola");
  });

  test.each([
    ["a blank title", "   ", "Hola", /title is blank, over 500 characters, or carries a NUL/],
    ["a long title", "U".repeat(501), "Hola", /title is blank, over 500 characters/],
    ["blank text", "Unidad 1", " \n ", /text is blank, or carries a NUL/],
    ["text carrying a NUL", "Unidad 1", "Hola\u0000", /text is blank, or carries a NUL/],
    ["a title carrying a NUL", "Unidad\u0000", "Hola", /or carries a NUL/],
    ["a title with an unpaired surrogate", "Unidad \ud800", "Hola", /unpaired surrogate/],
  ])("refuses %s, saying so, and stores nothing", async (_label, title, text, reason) => {
    const refused = add(title, text);
    await expect(refused).rejects.toBeInstanceOf(InvalidSource);
    await expect(refused).rejects.toThrow(reason);

    expect(await listSources({ database, organizationId, actingAs: author })).toEqual([]);
  });

  test("refuses a learner adding, listing, or reading sources", async () => {
    const id = await add("Unidad 1", "Hola");

    await expect(add("Snuck in", "Hola", learner)).rejects.toBeInstanceOf(NotPermitted);
    await expect(
      listSources({ database, organizationId, actingAs: learner }),
    ).rejects.toBeInstanceOf(NotPermitted);
    await expect(get(id, learner)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("answers another organization's source as one that does not exist", async () => {
    const theirs = await createSource(database, {
      organizationId: otherOrganizationId,
      title: "Theirs",
      text: "Secreto",
      createdAt: at,
    });

    expect(await get(theirs)).toBeUndefined();
    expect(await get("no-such-source")).toBeUndefined();
  });

  test("reads a source through the cache, but who may read it never", async () => {
    const id = await add("Unidad 1", "Hola");
    cachedStatements.length = 0;

    await expect(get(id, learner)).rejects.toBeInstanceOf(NotPermitted);
    expect(cachedStatements).toEqual([]);

    expect((await get(id))?.text).toBe("Hola");
    expect(cachedStatements).toEqual([expect.stringMatching(/ from "source" /)]);
  });
});
