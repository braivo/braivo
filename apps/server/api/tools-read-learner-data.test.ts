// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Whether tools read an organization's learners' data, over HTTP (ADR 0050):
// who reads and sets it, that no tool does, and that a tool's next request
// follows it. The record's rules are `application/organizations.test.ts`'s;
// each host's admission, `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { member } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";
import type { ToolsReadLearnerData } from "./types.ts";

const { database, api, signUp } = createTestApi();

const organizationId = "tools-setting-api-org";
const path = `/api/organizations/${organizationId}/tools-read-learner-data`;
const at = new Date("2026-06-01T00:00:00.000Z");

let owner!: Signed;
let admin!: Signed;
let author!: Signed;
let teacher!: Signed;
let learner!: Signed;
let stranger!: Signed;

const cookieOf = (signed: Signed) => ({ cookie: signed.cookie, origin: baseUrl });
const bearer = (signed: Signed) => ({ authorization: `Bearer ${signed.token}` });
const request = (
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  api.request(url, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = (headers: Record<string, string>) => request("GET", path, headers);
const set = (headers: Record<string, string>, allowed: unknown) =>
  request("POST", path, headers, { allowed });
/** The setting as the console reads it. */
const stored = async () => (await (await read(cookieOf(owner))).json()) as ToolsReadLearnerData;

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("whether tools read learners' data, over HTTP", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    [owner, admin, author, teacher, learner, stranger] = await Promise.all([
      signUp(),
      signUp(),
      signUp(),
      signUp(),
      signUp(),
      signUp(),
    ]);
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [author.id, teacher.id, learner.id],
      adminIds: [owner.id, admin.id],
      at,
    });
    for (const [signed, role] of [
      [owner, "owner"],
      [author, "author"],
    ] as const) {
      await database
        .update(member)
        .set({ role })
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, signed.id)));
    }
    const created = await request(
      "POST",
      `/api/organizations/${organizationId}/groups`,
      cookieOf(admin),
      { name: "7A", learnerIds: [learner.id], teacherIds: [teacher.id], courseIds: [] },
    );
    expect(created.status).toBe(201);
  });

  beforeEach(async () => {
    await testing.setToolsReadLearnerData(database, organizationId, false);
  });

  test("is read and set by an owner or admin in a browser, recorded as theirs", async () => {
    const turnedOn = await set(cookieOf(admin), true);

    expect(turnedOn.status).toBe(200);
    const answer = (await turnedOn.json()) as ToolsReadLearnerData;
    expect(answer).toEqual({
      allowed: true,
      changedBy: { userId: admin.id, name: admin.name },
      changedAt: expect.any(String),
    });
    expect(await stored()).toEqual(answer);
    expect(await (await read(cookieOf(admin))).json()).toEqual(answer);

    // The same value again changes nothing, its record included.
    expect(await (await set(cookieOf(owner), true)).json()).toEqual(answer);
  });

  test.each([
    ["an author", () => author],
    ["a teacher", () => teacher],
    ["a learner", () => learner],
    ["a non-member", () => stranger],
  ])("refuses %s, 403", async (_case, who) => {
    const before = await stored();

    expect((await read(cookieOf(who()))).status).toBe(403);
    expect((await set(cookieOf(who()), true)).status).toBe(403);
    expect(await stored()).toEqual(before);
  });

  test("refuses any tool, even an owner's token, and a cookie beside one, explained", async () => {
    const before = await stored();

    for (const headers of [
      bearer(owner),
      { ...cookieOf(owner), ...bearer(owner) },
      // Whichever person the token or the cookie is, the request is a tool's.
      { ...cookieOf(owner), ...bearer(learner) },
      { ...cookieOf(learner), ...bearer(owner) },
    ]) {
      for (const response of [await read(headers), await set(headers, true)]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "Decide whether tools read learners' data in Braivo's console.",
        });
      }
    }
    expect(await stored()).toEqual(before);
  });

  test("refuses a body without a boolean, 400", async () => {
    for (const allowed of [undefined, "true", 1, null]) {
      const response = await set(cookieOf(owner), allowed);
      expect([response.status, await response.text()]).toEqual([400, ""]);
    }
  });

  test("lets a tool's next request read the members once on, and refuses it once off", async () => {
    const members = () =>
      request("GET", `/api/organizations/${organizationId}/members`, bearer(owner));

    expect((await members()).status).toBe(403);
    await set(cookieOf(owner), true);
    expect((await members()).status).toBe(200);
    await set(cookieOf(admin), false);
    expect((await members()).status).toBe(403);
  });
});
