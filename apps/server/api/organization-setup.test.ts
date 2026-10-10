// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Self-serve onboarding (ADR 0018): `/api/organization-setup`, on an
// installation with `selfServeDomain` and on one without.

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import { baseUrl, connectionString, createTestApi } from "./testing.ts";

const selfServeDomain = "braivo.example";
const { database, api, signUp } = createTestApi({ selfServeDomain });
const operated = createTestApi();
/** A domain long enough that a long slug under it makes a hostname over 253 characters. */
const long = createTestApi({
  selfServeDomain: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example`,
});

/** Development's: each organization at `<slug>.localhost` (docs/guides/deployment.md). */
const local = createTestApi({ selfServeDomain: "localhost" });

/** Slugs fresh each run, since organizations outlive it. */
const run = crypto.randomUUID().slice(0, 8);
const at = new Date("2026-06-01T00:00:00.000Z");

const domain = (cookie?: string, on = api) =>
  on.request("/api/organization-setup", cookie ? { headers: { cookie } } : undefined);

const setUp = (body: unknown, cookie: string, on = api) =>
  on.request("/api/organization-setup", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const managed = async (cookie: string) =>
  (await (await api.request("/api/organizations", { headers: { cookie } })).json()) as {
    organizations: { slug: string; learnDomain: string | null }[];
  };

describe.skipIf(!connectionString)("setting up an organization", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
  });

  test("makes the account its owner, served at its slug under the domain", async () => {
    const teacher = await signUp();
    const slug = `fernwood-${run}`;

    expect(await (await domain(teacher.cookie)).json()).toEqual({ domain: selfServeDomain });
    const response = await setUp({ name: " Fernwood Academy ", slug }, teacher.cookie);

    expect(response.status).toBe(201);
    const learnDomain = `${slug}.${selfServeDomain}`;
    expect(await response.json()).toEqual({
      organization: { id: expect.any(String), name: "Fernwood Academy", slug, learnDomain },
    });
    expect((await managed(teacher.cookie)).organizations).toEqual([
      expect.objectContaining({ slug, learnDomain }),
    ]);
    // The learn app there presents it.
    const served = await api.request(`https://${learnDomain}/api/organization`);
    expect(await served.json()).toEqual({ name: "Fernwood Academy" });
  });

  test("serves one set up locally at its slug under localhost", async () => {
    const teacher = await local.signUp();
    const slug = `local-${run}`;

    const response = await setUp({ name: "Local", slug }, teacher.cookie, local.api);

    expect(response.status).toBe(201);
    const served = await local.api.request(`http://${slug}.localhost/api/organization`);
    expect(await served.json()).toEqual({ name: "Local" });
  });

  test("makes the session's account the owner, never one a request names or another site sends", async () => {
    const [teacher, other] = [await signUp(), await signUp()];

    // A write from another site, with the teacher's cookie, is refused.
    const forged = await api.request("/api/organization-setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: teacher.cookie,
        origin: "https://elsewhere.example",
      },
      body: JSON.stringify({ name: "Forged", slug: `forged-${run}` }),
    });
    expect(forged.status).toBe(403);
    expect((await managed(teacher.cookie)).organizations).toEqual([]);

    // A `userId` in the body names nobody.
    const response = await setUp(
      { name: "Own", slug: `named-${run}`, userId: other.id },
      teacher.cookie,
    );
    expect(response.status).toBe(201);
    expect((await managed(teacher.cookie)).organizations).toHaveLength(1);
    expect((await managed(other.cookie)).organizations).toEqual([]);
  });

  test("allows one organization per owner", async () => {
    const teacher = await signUp();

    expect((await setUp({ name: "First", slug: `first-${run}` }, teacher.cookie)).status).toBe(201);
    const second = await setUp({ name: "Second", slug: `second-${run}` }, teacher.cookie);

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "You already own an organization. Reload this page to open it.",
      code: "ALREADY_OWNER",
    });
    expect((await managed(teacher.cookie)).organizations).toHaveLength(1);
  });

  test("gives an address asked for by two at once to one, refusing the other as taken", async () => {
    const [first, second] = [await signUp(), await signUp()];
    const slug = `raced-${run}`;

    const answers = await Promise.all(
      [first, second].map(
        async ({ cookie }) => (await setUp({ name: "Raced", slug }, cookie)).status,
      ),
    );

    expect(answers.toSorted((a, b) => a - b)).toEqual([201, 409]);
  });

  test("refuses an address too long to be a hostname, creating nothing", async () => {
    const teacher = await long.signUp();

    const response = await setUp({ name: "Long", slug: "d".repeat(60) }, teacher.cookie, long.api);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("is not a valid address"),
      code: "ADDRESS_INVALID",
    });
    expect((await managed(teacher.cookie)).organizations).toEqual([]);
  });

  test("lets an administrator of another organization own one", async () => {
    const teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId: `setup-admin-${run}`,
      learnerIds: [],
      adminIds: [teacher.id],
      at,
    });

    expect((await setUp({ name: "Own", slug: `own-${run}` }, teacher.cookie)).status).toBe(201);
  });

  test("refuses an address taken, by slug or by hostname, creating nothing", async () => {
    const teacher = await signUp();
    // Operators' organizations: one with the slug and no learn domain, so only
    // the slug clashes; another, under another slug, already at the hostname.
    const slug = `taken-${run}`;
    await testing.seedOrganization(database, { organizationId: slug, learnerIds: [], at });
    const operators = `operators-${run}`;
    await testing.seedOrganization(database, { organizationId: operators, learnerIds: [], at });
    const hostname = `held-${run}.${selfServeDomain}`;
    await registerLearnDomain({ database, baseUrl, organizationSlug: operators, hostname });

    for (const [taken, address] of [
      [slug, `${slug}.${selfServeDomain}`],
      [`held-${run}`, hostname],
    ]) {
      const response = await setUp({ name: "Second", slug: taken }, teacher.cookie);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `${address} is taken. Choose another address.`,
        code: "ADDRESS_TAKEN",
      });
    }
    expect((await managed(teacher.cookie)).organizations).toEqual([]);
  });

  test.each([
    ["a slug Braivo's paths use", "login", "login.braivo.example is reserved", "ADDRESS_RESERVED"],
    ["a subdomain Braivo uses", "www", "www.braivo.example is reserved", "ADDRESS_RESERVED"],
    ["Braivo's demo", "demo", "demo.braivo.example is reserved", "ADDRESS_RESERVED"],
    ["a malformed slug", "fern--wood", "Use lowercase letters", "ADDRESS_INVALID"],
    ["a slug no hostname has", "Fern Wood", "Use lowercase letters", "ADDRESS_INVALID"],
  ])("refuses %s, saying what to change", async (_case, slug, advice, code) => {
    const teacher = await signUp();

    const response = await setUp({ name: "Fernwood", slug }, teacher.cookie);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining(advice), code });
    expect((await managed(teacher.cookie)).organizations).toEqual([]);
  });

  test.each([
    [
      "a blank name",
      { name: "  ", slug: `blank-${run}` },
      { error: expect.any(String), code: "NAME_INVALID" },
    ],
    [
      "a name too long",
      { name: "x".repeat(101), slug: `long-${run}` },
      { error: expect.any(String), code: "NAME_INVALID" },
    ],
    ["no slug", { name: "Fernwood" }, null],
    ["no body", null, null],
  ])("refuses %s", async (_case, body, answer) => {
    const teacher = await signUp();

    const response = await setUp(body, teacher.cookie);

    expect(response.status).toBe(400);
    expect(answer === null ? await response.text() : await response.json()).toEqual(answer ?? "");
    expect((await managed(teacher.cookie)).organizations).toEqual([]);
  });

  test("is off where the operator creates organizations", async () => {
    const teacher = await operated.signUp();

    expect(await (await domain(teacher.cookie, operated.api)).json()).toEqual({ domain: null });
    const response = await setUp(
      { name: "Fernwood", slug: `off-${run}` },
      teacher.cookie,
      operated.api,
    );

    expect(response.status).toBe(404);
    expect((await managed(teacher.cookie)).organizations).toEqual([]);
  });
});
