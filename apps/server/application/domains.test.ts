// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organization, organizationDomain } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase, violatedConstraint } from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { DomainRefused, registerLearnDomain } from "./domains.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

/** Seeded with its slug equal to its ID. */
const school = "domains-test-school";
const otherSchool = "domains-test-other-school";
const baseUrl = "https://braivo.example";
const at = new Date("2026-01-01T00:00:00.000Z");

const register = (hostname: string, organizationSlug = school, installation = baseUrl) =>
  registerLearnDomain({ database, baseUrl: installation, organizationSlug, hostname });

/** What `register` refused with, failing the test when it registered instead. */
async function refusal(registered: Promise<unknown>): Promise<string> {
  const thrown = await registered.then(
    () => expect.fail("registered"),
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(DomainRefused);
  return (thrown as DomainRefused).message;
}

describe("a hostname a learn domain may have", () => {
  // Each is refused before the database is asked, so these need none.
  test.each([
    ["a scheme", "https://learn.example.com"],
    ["a port", "learn.example.com:8443"],
    ["a path", "learn.example.com/learn"],
    ["a trailing dot", "learn.example.com."],
    ["an empty label", "learn..example.com"],
    ["a label starting with a hyphen", "-learn.example.com"],
    ["a label ending with a hyphen", "learn-.example.com"],
    ["an underscore", "learn_here.example.com"],
    ["whitespace", " learn.example.com"],
    ["a label over 63 characters", `${"a".repeat(64)}.example.com`],
    ["a name over 253 characters", `${"a.".repeat(126)}com`],
    ["an IPv4 address", "192.0.2.1"],
    ["a hexadecimal number URLs read as an address", "learn.0x1f"],
    ["an IPv6 address", "[2001:db8::1]"],
    ["a malformed xn-- label", "xn--zz.example.com"],
  ])("refuses %s", async (_case, hostname) => {
    expect(await refusal(register(hostname))).toContain("cannot be a learn domain");
  });

  test.each([
    ["Unicode", "école.example.com"],
    // Lowercased, it would be ASCII `k`: a different name from the one asked for.
    ["a letter that lowercases to ASCII", "Kids.example.com"],
  ])("refuses %s, asking for the xn-- form", async (_case, hostname) => {
    expect(await refusal(register(hostname))).toContain("xn-- form");
  });

  test("refuses the installation's own hostname, whichever side is in capitals", async () => {
    expect(await refusal(register("Braivo.Example"))).toContain("installation's own");
    expect(await refusal(register("braivo.example", school, "https://Braivo.Example"))).toContain(
      "installation's own",
    );
  });
});

/** Requires TEST_DATABASE_URL: what is taken is the database's to say. */
describe.skipIf(!connectionString)("registerLearnDomain", () => {
  beforeAll(() => runMigrations(connectionString ?? ""));

  beforeEach(async () => {
    for (const organizationId of [school, otherSchool]) {
      await seedOrganization(database, { organizationId, learnerIds: [], at });
    }
    await database
      .delete(organizationDomain)
      .where(inArray(organizationDomain.organizationId, [school, otherSchool]));
  });

  test("maps the hostname, lowercased, to the organization", async () => {
    const domain = await register("Learn.Domains-Test.example");

    expect(domain).toEqual({
      organization: { id: school, name: school, slug: school },
      hostname: "learn.domains-test.example",
    });
    const rows = await database
      .select()
      .from(organizationDomain)
      .where(inArray(organizationDomain.organizationId, [school]));
    expect(rows).toEqual([{ hostname: "learn.domains-test.example", organizationId: school }]);
  });

  test("accepts a subdomain of the installation's hostname", async () => {
    expect((await register(`${school}.braivo.example`)).hostname).toBe(`${school}.braivo.example`);
  });

  test.each([
    ["a single label, as internal DNS may serve", "training"],
    ["a top-level label starting with a digit", "training.1corp"],
    ["a numeric label before the last", "1.domains-test.example"],
    ["a punycode top-level domain", "domains-test.xn--p1ai"],
    ["a single-letter label", "a.domains-test.example"],
    ["a label of 63 characters", `${"a".repeat(63)}.domains-test.example`],
    [
      "a name of 253 characters",
      `${["a", "b", "c"].map((c) => c.repeat(63)).join(".")}.${"d".repeat(61)}`,
    ],
  ])("accepts %s", async (_case, hostname) => {
    expect((await register(hostname)).hostname).toBe(hostname);
  });

  test("confirms a mapping already there, so a retry succeeds", async () => {
    await register("learn.domains-test.example");

    const again = await register("Learn.Domains-Test.example");

    expect(again).toEqual({
      organization: { id: school, name: school, slug: school },
      hostname: "learn.domains-test.example",
    });
  });

  test("refuses a slug no organization has", async () => {
    expect(await refusal(register("learn.domains-test.example", "domains-test-none"))).toBe(
      'No organization has the slug "domains-test-none".',
    );
  });

  test("refuses a hostname another organization has, naming it", async () => {
    await register("learn.domains-test.example", otherSchool);

    expect(await refusal(register("learn.domains-test.example"))).toBe(
      `learn.domains-test.example already serves ${otherSchool} (${otherSchool}).`,
    );
  });

  test("frees a hostname once its organization is deleted", async () => {
    await register("learn.domains-test.example", otherSchool);

    await database.delete(organization).where(eq(organization.id, otherSchool));

    expect((await register("learn.domains-test.example")).organization.id).toBe(school);
  });

  test("refuses a second domain for one organization, naming the first", async () => {
    await register("learn.domains-test.example");

    expect(await refusal(register("study.domains-test.example"))).toContain(
      "already served at learn.domains-test.example",
    );
  });

  test("confirms the same mapping asked for twice at once, keeping one row", async () => {
    const both = await Promise.all([
      register("learn.domains-test.example"),
      register("learn.domains-test.example"),
    ]);

    const expected = {
      organization: { id: school, name: school, slug: school },
      hostname: "learn.domains-test.example",
    };
    expect(both).toEqual([expected, expected]);
    const rows = await database
      .select()
      .from(organizationDomain)
      .where(eq(organizationDomain.hostname, "learn.domains-test.example"));
    expect(rows).toEqual([{ hostname: "learn.domains-test.example", organizationId: school }]);
  });

  test("lets one of two concurrent registrations for an organization win", async () => {
    const outcomes = await Promise.allSettled([
      register("learn.domains-test.example"),
      register("study.domains-test.example"),
    ]);

    expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(DomainRefused);
  });

  test("lets one of two organizations registering a hostname at once have it", async () => {
    const outcomes = await Promise.allSettled([
      register("learn.domains-test.example"),
      register("learn.domains-test.example", otherSchool),
    ]);

    const [won] = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const [lost] = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    expect(lost).toBeInstanceOf(DomainRefused);
    const rows = await database
      .select({ organizationId: organizationDomain.organizationId })
      .from(organizationDomain)
      .where(eq(organizationDomain.hostname, "learn.domains-test.example"));
    expect(rows).toEqual([{ organizationId: won?.organization.id }]);
  });

  test("the database, not only this check, holds an organization to one domain", async () => {
    await register("learn.domains-test.example");

    const refused = await database
      .insert(organizationDomain)
      .values({ hostname: "study.domains-test.example", organizationId: school })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(refused)).toBe("organization_domain_organization_idx");
  });
});
