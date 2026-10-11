// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import {
  learnerSession,
  organization,
  organizationDomain,
  organizationDomainClaim,
} from "@braivo/db/schema";
import { seedOrganization, sharedDatabase } from "@braivo/db/testing";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { readDomainOrganization, readDomains, readLearnDomain } from "../persistence/index.ts";
import {
  activateDomain,
  claimDomain,
  type DomainProvisioner,
  DomainRefused,
  type DomainStatus,
  listDomains,
  ProvisioningFailed,
  PROVISIONER_REMOVE_MS,
  registerLearnDomain,
  removeDomain,
} from "./domains.ts";
import { NotPermitted } from "./permission.ts";

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
    expect(rows).toEqual([
      {
        hostname: "learn.domains-test.example",
        organizationId: school,
        registeredAt: expect.any(Date),
        // Registered by the operator, so proven by no claim.
        claimId: null,
      },
    ]);
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

  test("serves an organization at several, named by the latest, the earlier still serving", async () => {
    // Its self-serve subdomain, then its own domain.
    await register("school.braivo.example");
    await register("learn.domains-test.example");

    expect(await readLearnDomain(database, school)).toBe("learn.domains-test.example");
    // Listed newest first, the one it is named by leading.
    expect(await readDomains(database, school)).toEqual([
      { hostname: "learn.domains-test.example" },
      { hostname: "school.braivo.example" },
    ]);
    for (const hostname of ["school.braivo.example", "learn.domains-test.example"]) {
      expect((await readDomainOrganization(database, hostname))?.id).toBe(school);
    }
    // Confirming an earlier one changes nothing.
    await register("school.braivo.example");
    expect(await readLearnDomain(database, school)).toBe("learn.domains-test.example");
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
    expect(rows).toEqual([
      {
        hostname: "learn.domains-test.example",
        organizationId: school,
        registeredAt: expect.any(Date),
        // Registered by the operator, so proven by no claim.
        claimId: null,
      },
    ]);
  });

  test("registers two domains for one organization at once, both serving it", async () => {
    await Promise.all([
      register("learn.domains-test.example"),
      register("study.domains-test.example"),
    ]);

    for (const hostname of ["learn.domains-test.example", "study.domains-test.example"]) {
      expect((await readDomainOrganization(database, hostname))?.id).toBe(school);
    }
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
});

/** Requires TEST_DATABASE_URL: claims live beside domains, under one lock. */
describe.skipIf(!connectionString)("claimDomain", () => {
  beforeAll(() => runMigrations(connectionString ?? ""));

  const admin = "domains-test-admin";
  const otherAdmin = "domains-test-other-admin";
  const learner = "domains-test-learner";
  const hostname = "learn.claims-test.example";
  const pending: DomainStatus = {
    ready: false,
    records: [
      { type: "CNAME", name: hostname, value: "domains.braivo.example" },
      { type: "TXT", name: `_braivo.${hostname}`, value: "token" },
    ],
  };

  /** A provisioner that answers `pending` and records what it was asked. */
  function provisioner(overrides: Partial<DomainProvisioner> = {}) {
    const asked: string[] = [];
    const fake: DomainProvisioner = {
      add: async (name) => (asked.push(`add ${name}`), pending),
      status: async (name) => (asked.push(`status ${name}`), pending),
      remove: async (name) => void asked.push(`remove ${name}`),
      ...overrides,
    };
    return { fake, asked };
  }

  const claim = (
    fake: DomainProvisioner,
    name = hostname,
    organizationId = school,
    actingAs = organizationId === school ? admin : otherAdmin,
  ) =>
    claimDomain({
      database,
      provisioner: fake,
      baseUrl,
      selfServeDomain: "schools.example",
      organizationId,
      actingAs,
      hostname: name,
    });

  /** What `claim` refused with, as its code. */
  async function refusedCode(claimed: Promise<unknown>): Promise<string> {
    const thrown = await claimed.then(
      () => expect.fail("claimed"),
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(DomainRefused);
    return (thrown as DomainRefused).code;
  }

  const claimsOf = (organizationId: string) =>
    database
      .select({ hostname: organizationDomainClaim.hostname })
      .from(organizationDomainClaim)
      .where(eq(organizationDomainClaim.organizationId, organizationId));

  beforeEach(async () => {
    await seedOrganization(database, {
      organizationId: school,
      learnerIds: [learner],
      adminIds: [admin],
      at,
    });
    await seedOrganization(database, {
      organizationId: otherSchool,
      learnerIds: [],
      adminIds: [otherAdmin],
      at,
    });
    for (const table of [organizationDomain, organizationDomainClaim]) {
      await database.delete(table).where(inArray(table.organizationId, [school, otherSchool]));
    }
  });

  test("claims a hostname, lowercased, answering the records to create, serving nothing yet", async () => {
    await register("school.braivo.example");
    const { fake, asked } = provisioner();

    expect(await claim(fake, "Learn.Claims-Test.example")).toEqual({ hostname, status: pending });
    expect(asked).toEqual([`add ${hostname}`]);

    // Not served, not trusted, and the learn domain unchanged.
    expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    expect(await readLearnDomain(database, school)).toBe("school.braivo.example");
    expect(
      await listDomains({
        database,
        provisioner: fake,
        baseUrl,
        organizationId: school,
        actingAs: admin,
      }),
    ).toEqual({
      domains: [{ hostname: "school.braivo.example", removable: false }],
      claims: [{ hostname, status: pending }],
      canAdd: true,
    });
  });

  test("asks again when claimed again, as a retry does, keeping one claim", async () => {
    const { fake, asked } = provisioner();
    await claim(fake);
    await claim(fake);
    expect(asked).toEqual([`add ${hostname}`, `add ${hostname}`]);
    expect(await claimsOf(school)).toEqual([{ hostname }]);
  });

  test.each([
    ["the installation's hostname", "braivo.example"],
    ["the self-serve domain", "schools.example"],
    ["one of its subdomains, which setup gives out", "anything.schools.example"],
  ])("refuses %s", async (_case, name) => {
    const { fake, asked } = provisioner();
    expect(await refusedCode(claim(fake, name))).toBe("DOMAIN_RESERVED");
    expect(asked).toEqual([]);
  });

  test("refuses a malformed hostname", async () => {
    expect(await refusedCode(claim(provisioner().fake, "https://learn.example.com"))).toBe(
      "DOMAIN_INVALID",
    );
  });

  test("refuses a hostname another organization serves or claimed, and one this one serves", async () => {
    await register("served.claims-test.example", otherSchool);
    await claim(provisioner().fake, "claimed.claims-test.example", otherSchool);
    await register("ours.claims-test.example");
    const { fake, asked } = provisioner();

    expect(await refusedCode(claim(fake, "served.claims-test.example"))).toBe("DOMAIN_TAKEN");
    expect(await refusedCode(claim(fake, "claimed.claims-test.example"))).toBe("DOMAIN_TAKEN");
    // Never saying whose, as the operator's refusal does.
    const thrown = await claim(fake, "served.claims-test.example").catch((error: unknown) => error);
    expect((thrown as Error).message).not.toContain(otherSchool);
    expect(await refusedCode(claim(fake, "ours.claims-test.example"))).toBe("ALREADY_ADDED");
    expect(asked).toEqual([]);
    expect(await claimsOf(school)).toEqual([]);
  });

  test("refuses a member who does not administer the organization", async () => {
    const claimed = claim(provisioner().fake, hostname, school, learner);
    await expect(claimed).rejects.toBeInstanceOf(NotPermitted);
    expect(await claimsOf(school)).toEqual([]);
  });

  test("keeps the claim when the provisioner fails, for claiming again to ask again", async () => {
    const failing = provisioner({
      add: async () => {
        throw new Error("Cloudflare is down");
      },
    }).fake;

    await expect(claim(failing)).rejects.toBeInstanceOf(ProvisioningFailed);
    expect(await claimsOf(school)).toEqual([{ hostname }]);

    const { fake, asked } = provisioner();
    expect(await claim(fake)).toEqual({ hostname, status: pending });
    expect(asked).toEqual([`add ${hostname}`]);
  });

  test("keeps a claim a retry made good while a first attempt still failed", async () => {
    const first = Promise.withResolvers<DomainStatus>();
    const slow = provisioner({ add: () => first.promise }).fake;

    const attempt = claim(slow);
    // The retry, once the first attempt has claimed and is waiting.
    await vi.waitFor(async () => expect(await claimsOf(school)).toEqual([{ hostname }]));
    expect(await claim(provisioner().fake)).toEqual({ hostname, status: pending });
    first.reject(new Error("Cloudflare timed out"));

    await expect(attempt).rejects.toBeInstanceOf(ProvisioningFailed);
    expect(await claimsOf(school)).toEqual([{ hostname }]);
  });

  test("lists a claim whose status cannot be read, its status unknown", async () => {
    await claim(provisioner().fake);
    const failing = provisioner({
      status: async () => {
        throw new Error("Cloudflare is down");
      },
    }).fake;

    const listed = await listDomains({
      database,
      provisioner: failing,
      baseUrl,
      organizationId: school,
      actingAs: admin,
    });
    expect(listed.claims).toEqual([{ hostname, status: null }]);
  });

  test("lists without a provisioner, offering no way to add", async () => {
    await claim(provisioner().fake);
    expect(
      await listDomains({ database, baseUrl, organizationId: school, actingAs: admin }),
    ).toEqual({
      domains: [],
      claims: [{ hostname, status: null }],
      canAdd: false,
    });
  });

  test("lets the operator register a hostname its organization claimed, the claim giving way", async () => {
    await claim(provisioner().fake);
    await register(hostname);
    expect(await readDomainOrganization(database, hostname)).toMatchObject({ id: school });
    expect(await claimsOf(school)).toEqual([]);
  });

  test("refuses the operator a hostname another organization claimed, naming it", async () => {
    await claim(provisioner().fake, hostname, otherSchool);
    expect(await refusal(register(hostname))).toBe(
      `${otherSchool} (${otherSchool}) has claimed ${hostname}.`,
    );
    expect(await readDomainOrganization(database, hostname)).toBeUndefined();
  });

  /** Ages `name`'s claim past its seven days. */
  const expire = (name = hostname) =>
    database
      .update(organizationDomainClaim)
      .set({ claimedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(organizationDomainClaim.hostname, name));

  /** The ID of the claim to `name`, whoever holds it. */
  async function claimId(name = hostname): Promise<number | undefined> {
    const [row] = await database
      .select({ id: organizationDomainClaim.id })
      .from(organizationDomainClaim)
      .where(eq(organizationDomainClaim.hostname, name));
    return row?.id;
  }

  test("lets a claim seven days old go: unlisted, then another's to claim", async () => {
    await claim(provisioner().fake);
    const first = await claimId();
    await expire();

    const listed = await listDomains({
      database,
      baseUrl,
      organizationId: school,
      actingAs: admin,
    });
    expect(listed.claims).toEqual([]);
    expect(await claim(provisioner().fake, hostname, otherSchool)).toEqual({
      hostname,
      status: pending,
    });
    expect(await claimsOf(school)).toEqual([]);
    expect(await claimsOf(otherSchool)).toEqual([{ hostname }]);
    expect(await claimId()).toBeGreaterThan(first ?? Infinity);
  });

  test("claims anew a hostname whose own claim expired, so it is proven afresh", async () => {
    await claim(provisioner().fake);
    const first = await claimId();
    // A retry while it holds keeps the claim.
    await claim(provisioner().fake);
    expect(await claimId()).toBe(first);

    await expire();
    await claim(provisioner().fake);
    expect(await claimId()).toBeGreaterThan(first ?? Infinity);
  });

  test("lets the operator register a hostname another organization's claim held until it expired", async () => {
    await claim(provisioner().fake, hostname, otherSchool);
    await expire();
    await register(hostname);
    expect(await readDomainOrganization(database, hostname)).toMatchObject({ id: school });
    expect(await claimsOf(otherSchool)).toEqual([]);
  });

  test("names each claim to the provisioner by its ID, the same on a retry, greater once expired", async () => {
    const calls: string[] = [];
    const fake: DomainProvisioner = {
      add: async (_name, id) => (calls.push(`add ${id}`), pending),
      status: async (_name, id) => (calls.push(`status ${id}`), pending),
      remove: async () => {},
    };
    await claim(fake);
    const first = await claimId();
    await claim(fake);
    await listDomains({
      database,
      provisioner: fake,
      baseUrl,
      organizationId: school,
      actingAs: admin,
    });
    expect(calls).toEqual([`add ${first}`, `add ${first}`, `status ${first}`]);

    await expire();
    await claim(fake);
    const second = await claimId();
    expect(second).toBeGreaterThan(first ?? Infinity);
    expect(calls.at(-1)).toBe(`add ${second}`);
  });

  test("lets one of two organizations claiming a hostname at once have it", async () => {
    const outcomes = await Promise.allSettled([
      claim(provisioner().fake, hostname, school),
      claim(provisioner().fake, hostname, otherSchool),
    ]);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const held = [...(await claimsOf(school)), ...(await claimsOf(otherSchool))];
    expect(held).toEqual([{ hostname }]);
  });

  test("lets a claim and the operator's registration at once leave the hostname one organization's", async () => {
    for (let round = 0; round < 10; round++) {
      await database
        .delete(organizationDomainClaim)
        .where(eq(organizationDomainClaim.hostname, hostname));
      await database.delete(organizationDomain).where(eq(organizationDomain.hostname, hostname));

      await Promise.allSettled([
        claim(provisioner().fake, hostname, otherSchool),
        register(hostname),
      ]);

      const claimed = await database
        .select({ organizationId: organizationDomainClaim.organizationId })
        .from(organizationDomainClaim)
        .where(eq(organizationDomainClaim.hostname, hostname));
      const served = await database
        .select({ organizationId: organizationDomain.organizationId })
        .from(organizationDomain)
        .where(eq(organizationDomain.hostname, hostname));
      expect(claimed.length + served.length).toBe(1);
    }
  });

  describe("activateDomain", () => {
    const ready: DomainStatus = { ...pending, ready: true };
    const activate = (fake: DomainProvisioner, name = hostname, actingAs = admin) =>
      activateDomain({
        database,
        provisioner: fake,
        organizationId: school,
        actingAs,
        hostname: name,
      });

    test("leaves a claim not yet proven claimed, answering where it stands", async () => {
      await claim(provisioner().fake);
      expect(await activate(provisioner().fake)).toEqual({ active: false, status: pending });
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
      expect(await claimsOf(school)).toEqual([{ hostname }]);
    });

    test("makes a proven claim serve, as the primary domain, and succeeds again", async () => {
      await register("school.braivo.example");
      await claim(provisioner().fake);
      const { fake, asked } = provisioner({ status: async () => ready });

      expect(await activate(fake, "Learn.Claims-Test.example")).toEqual({ active: true });
      expect(await readDomainOrganization(database, hostname)).toMatchObject({ id: school });
      expect(await readLearnDomain(database, school)).toBe(hostname);
      expect(await claimsOf(school)).toEqual([]);

      // Serving already: not asked again.
      asked.length = 0;
      expect(await activate(fake)).toEqual({ active: true });
      expect(asked).toEqual([]);
    });

    test("refuses a hostname the organization has not claimed, asking nothing about it", async () => {
      await claim(provisioner().fake, hostname, otherSchool);
      const { fake, asked } = provisioner();
      expect(await refusedCode(activate(fake))).toBe("NOT_CLAIMED");
      expect(asked).toEqual([]);
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    });

    test("refuses a hostname claiming refuses, though lowercased it names a claim", async () => {
      await claim(provisioner().fake, "kids.claims-test.example");
      const { fake, asked } = provisioner({ status: async () => ready });
      // The Kelvin sign, lowercased, is `k`.
      expect(await refusedCode(activate(fake, "\u212Aids.claims-test.example"))).toBe(
        "DOMAIN_INVALID",
      );
      expect(asked).toEqual([]);
    });

    test("refuses a member who does not administer the organization", async () => {
      await claim(provisioner().fake);
      const activated = activate(
        provisioner({ status: async () => ready }).fake,
        hostname,
        learner,
      );
      await expect(activated).rejects.toBeInstanceOf(NotPermitted);
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    });

    test("keeps the claim when the provisioner cannot say", async () => {
      await claim(provisioner().fake);
      const failing = provisioner({
        status: async () => {
          throw new Error("Cloudflare is down");
        },
      }).fake;
      await expect(activate(failing)).rejects.toBeInstanceOf(ProvisioningFailed);
      expect(await claimsOf(school)).toEqual([{ hostname }]);
    });

    test("refuses an expired claim, asking nothing about it", async () => {
      await claim(provisioner().fake);
      await expire();
      const { fake, asked } = provisioner();
      expect(await refusedCode(activate(fake))).toBe("NOT_CLAIMED");
      expect(asked).toEqual([]);
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    });

    test("does not pass a proof to the claim made after its own expired", async () => {
      await claim(provisioner().fake);
      const answered = Promise.withResolvers<DomainStatus>();
      const asked = Promise.withResolvers<void>();
      const slow = provisioner({
        status: () => {
          asked.resolve();
          return answered.promise;
        },
      }).fake;

      const activating = activate(slow);
      await asked.promise;
      // Meanwhile: expired, and claimed again, its proof still to come.
      await expire();
      await claim(provisioner().fake);
      answered.resolve(ready);

      expect(await refusedCode(activating)).toBe("NOT_CLAIMED");
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
      expect(await claimsOf(school)).toEqual([{ hostname }]);
    });

    test("does not pass a proof to the claim made after its own was removed", async () => {
      await claim(provisioner().fake);
      const answered = Promise.withResolvers<DomainStatus>();
      const asked = Promise.withResolvers<void>();
      const slow = provisioner({
        status: () => {
          asked.resolve();
          return answered.promise;
        },
      }).fake;

      const activating = activate(slow);
      await asked.promise;
      // Meanwhile: removed, and claimed again, its proof still to come.
      await removeDomain({
        database,
        provisioner: provisioner().fake,
        baseUrl,
        organizationId: school,
        actingAs: admin,
        hostname,
      });
      await claim(provisioner().fake);
      answered.resolve(ready);

      expect(await refusedCode(activating)).toBe("NOT_CLAIMED");
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
      expect(await claimsOf(school)).toEqual([{ hostname }]);
    });

    test("activates once when asked twice at once", async () => {
      await claim(provisioner().fake);
      const fake = provisioner({ status: async () => ready }).fake;
      expect(await Promise.all([activate(fake), activate(fake)])).toEqual([
        { active: true },
        { active: true },
      ]);
      const served = await database
        .select({ organizationId: organizationDomain.organizationId })
        .from(organizationDomain)
        .where(eq(organizationDomain.hostname, hostname));
      expect(served).toEqual([{ organizationId: school }]);
    });
  });

  describe("removeDomain", () => {
    const remove = (fake: DomainProvisioner, name = hostname, actingAs = admin) =>
      removeDomain({
        database,
        provisioner: fake,
        baseUrl,
        selfServeDomain: "schools.example",
        organizationId: school,
        actingAs,
        hostname: name,
      });

    test("removes a claim, telling the provisioner", async () => {
      await claim(provisioner().fake);
      const { fake, asked } = provisioner();
      await remove(fake, "Learn.Claims-Test.example");
      expect(asked).toEqual([`remove ${hostname}`]);
      expect(await claimsOf(school)).toEqual([]);
    });

    test("stops a domain serving at once, its sessions too, the primary falling back", async () => {
      await register("school.schools.example");
      // Proven by a claim, so the provisioner's to forget.
      await claim(provisioner().fake);
      await activateDomain({
        database,
        provisioner: provisioner({ status: async () => ({ ...pending, ready: true }) }).fake,
        organizationId: school,
        actingAs: admin,
        hostname,
      });
      const { fake, asked } = provisioner();
      expect(
        (
          await listDomains({
            database,
            provisioner: fake,
            baseUrl,
            organizationId: school,
            actingAs: admin,
            selfServeDomain: "schools.example",
          })
        ).domains,
      ).toEqual([
        { hostname, removable: true },
        { hostname: "school.schools.example", removable: false },
      ]);
      // Otherwise, added back, the domain would let them in again (access-17).
      const expiresAt = new Date(Date.now() + 60_000);
      await database.delete(learnerSession).where(eq(learnerSession.userId, learner));
      await database.insert(learnerSession).values([
        {
          tokenHash: "domains-test-there",
          userId: learner,
          organizationId: school,
          hostname,
          expiresAt,
        },
        {
          tokenHash: "domains-test-elsewhere",
          userId: learner,
          organizationId: school,
          hostname: "school.schools.example",
          expiresAt,
        },
      ]);

      await remove(fake);
      expect(asked).toEqual([`remove ${hostname}`]);
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
      expect(await readLearnDomain(database, school)).toBe("school.schools.example");
      expect(
        await database
          .select({ tokenHash: learnerSession.tokenHash })
          .from(learnerSession)
          .where(eq(learnerSession.userId, learner)),
      ).toEqual([{ tokenHash: "domains-test-elsewhere" }]);
    });

    test("leaves a domain the operator registered alone at the provisioner", async () => {
      await register("school.schools.example");
      await register(hostname);
      const { fake, asked } = provisioner();
      await remove(fake);
      expect(asked).toEqual([]);
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    });

    test("refuses the installation's own hostnames and the last domain, asking nothing", async () => {
      await register("school.schools.example");
      await register("braivo.example.other");
      const { fake, asked } = provisioner();

      expect(await refusedCode(remove(fake, "school.schools.example"))).toBe("DOMAIN_RESERVED");
      expect(await refusedCode(remove(fake, "braivo.example"))).toBe("DOMAIN_RESERVED");
      await database
        .delete(organizationDomain)
        .where(eq(organizationDomain.hostname, "school.schools.example"));
      expect(await refusedCode(remove(fake, "braivo.example.other"))).toBe("LAST_DOMAIN");
      expect(asked).toEqual([]);
      expect(await readDomainOrganization(database, "braivo.example.other")).toMatchObject({
        id: school,
      });
    });

    test("refuses a hostname another organization holds, asking nothing", async () => {
      await claim(provisioner().fake, hostname, otherSchool);
      const { fake, asked } = provisioner();
      expect(await refusedCode(remove(fake))).toBe("NOT_CLAIMED");
      expect(asked).toEqual([]);
      expect(await claimsOf(otherSchool)).toEqual([{ hostname }]);
    });

    test("refuses a hostname claiming refuses, though lowercased it names a claim", async () => {
      await claim(provisioner().fake, "kids.claims-test.example");
      const { fake, asked } = provisioner();
      // The Kelvin sign, lowercased, is `k`.
      expect(await refusedCode(remove(fake, "\u212Aids.claims-test.example"))).toBe(
        "DOMAIN_INVALID",
      );
      expect(asked).toEqual([]);
      expect(await claimsOf(school)).toEqual([{ hostname: "kids.claims-test.example" }]);
    });

    test("refuses a member who does not administer the organization", async () => {
      await claim(provisioner().fake);
      await expect(remove(provisioner().fake, hostname, learner)).rejects.toBeInstanceOf(
        NotPermitted,
      );
      expect(await claimsOf(school)).toEqual([{ hostname }]);
    });

    test("removes here though the provisioner fails", async () => {
      await claim(provisioner().fake);
      const failing = provisioner({
        remove: async () => {
          throw new Error("Cloudflare is down");
        },
      }).fake;

      await remove(failing);
      expect(await claimsOf(school)).toEqual([]);
    });

    test("removes here though the provisioner throws before answering", async () => {
      await claim(provisioner().fake);
      const throwing = provisioner({
        remove: () => {
          throw new Error("Not configured");
        },
      }).fake;

      await remove(throwing);
      expect(await claimsOf(school)).toEqual([]);
    });

    /**
     * A provisioner as the contract has it: one resource per hostname, the
     * claim's whose ID made it; added for a later claim, replaced, its proof
     * to be made anew, and for an earlier one, ignored; removed only for its
     * own claim.
     */
    function claimBoundProvisioner() {
      const served = new Map<string, { claim: number; ready: boolean }>();
      const statusOf = (name: string, claim: number): DomainStatus => ({
        ...pending,
        ready: served.get(name)?.claim === claim && served.get(name)?.ready === true,
      });
      const fake: DomainProvisioner = {
        add: async (name, claim) => {
          const held = served.get(name)?.claim;
          if (held === undefined || claim > held) served.set(name, { claim, ready: false });
          return statusOf(name, claim);
        },
        status: async (name, claim) => statusOf(name, claim),
        remove: async (name, claim) => {
          if (served.get(name)?.claim === claim) served.delete(name);
        },
      };
      /** Its DNS records found, and its certificate issued. */
      const prove = (name: string) => served.set(name, { ...served.get(name)!, ready: true });
      return { fake, served, prove };
    }

    test("proves a hostname claimed again anew, what an earlier claim left proving nothing", async () => {
      const provider = claimBoundProvisioner();
      await claim(provider.fake);
      provider.prove(hostname);
      // Removed, the provisioner failing to forget it: its proof still there.
      await remove({ ...provider.fake, remove: async () => Promise.reject(new Error("down")) });
      expect(provider.served.get(hostname)?.ready).toBe(true);

      await claim(provider.fake, hostname, otherSchool);
      expect(
        await activateDomain({
          database,
          provisioner: provider.fake,
          organizationId: otherSchool,
          actingAs: otherAdmin,
          hostname,
        }),
      ).toMatchObject({ active: false });
      expect(await readDomainOrganization(database, hostname)).toBeUndefined();
    });

    test("never lets a late addition for a claim undo the claim made after it", async () => {
      const provider = claimBoundProvisioner();
      const asked = Promise.withResolvers<void>();
      const told = Promise.withResolvers<void>();
      // The first claim's addition, slow to arrive.
      const adding = claim({
        ...provider.fake,
        add: async (name, claimId) => {
          asked.resolve();
          await told.promise;
          return provider.fake.add(name, claimId);
        },
      });
      await asked.promise;
      await remove(provider.fake);
      // Another organization claims it, proves it, and activates it meanwhile.
      await claim(provider.fake, hostname, otherSchool);
      provider.prove(hostname);
      const activated = await activateDomain({
        database,
        provisioner: provider.fake,
        organizationId: otherSchool,
        actingAs: otherAdmin,
        hostname,
      });
      expect(activated).toEqual({ active: true });

      told.resolve();
      await adding;
      expect(provider.served.get(hostname)?.ready).toBe(true);
      expect(await readDomainOrganization(database, hostname)).toMatchObject({ id: otherSchool });
    });

    test("never lets a late removal of a claim undo the claim made after it", async () => {
      const provider = claimBoundProvisioner();
      await claim(provider.fake);
      const first = provider.served.get(hostname)?.claim;
      const asked = Promise.withResolvers<void>();
      const told = Promise.withResolvers<void>();

      const removing = remove({
        ...provider.fake,
        remove: async (name, claimId, options) => {
          asked.resolve();
          await told.promise;
          return provider.fake.remove(name, claimId, options);
        },
      });
      await asked.promise;
      // Removed here already: another organization claims it meanwhile.
      await claim(provider.fake, hostname, otherSchool);
      const second = provider.served.get(hostname)?.claim;
      // A later claim's ID is greater, which the provisioner orders them by.
      expect(second).toBeGreaterThan(first!);

      told.resolve();
      await removing;
      expect(provider.served.get(hostname)?.claim).toBe(second);
      expect(await claimsOf(otherSchool)).toEqual([{ hostname }]);
    });

    test("stops waiting for a provisioner that does not answer, removing all the same", async () => {
      await claim(provisioner().fake);
      let signalled: AbortSignal | undefined;
      const silent = provisioner({
        remove: (_name, _claim, { signal }) => {
          signalled = signal;
          return new Promise<void>(() => {});
        },
      }).fake;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const removing = remove(silent);
        await vi.waitFor(() => expect(signalled).toBeDefined());
        await vi.advanceTimersByTimeAsync(PROVISIONER_REMOVE_MS);
        await removing;
      } finally {
        vi.useRealTimers();
      }
      expect(signalled?.aborted).toBe(true);
      expect(await claimsOf(school)).toEqual([]);
    });

    test("leaves one domain when its last two are removed at once", async () => {
      await register("first.claims-test.example");
      await register("second.claims-test.example");
      const outcomes = await Promise.allSettled([
        remove(provisioner().fake, "first.claims-test.example"),
        remove(provisioner().fake, "second.claims-test.example"),
      ]);
      const refused = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toMatchObject({ code: "LAST_DOMAIN" });
      const served = await database
        .select({ hostname: organizationDomain.hostname })
        .from(organizationDomain)
        .where(eq(organizationDomain.organizationId, school));
      expect(served).toHaveLength(1);
    });
  });
});

/** Requires TEST_DATABASE_URL. */
describe.skipIf(!connectionString)("listDomains", () => {
  beforeAll(() => runMigrations(connectionString ?? ""));

  const admin = "domains-test-admin";
  const otherAdmin = "domains-test-other-admin";
  const learner = "domains-test-learner";

  beforeEach(async () => {
    await seedOrganization(database, {
      organizationId: school,
      learnerIds: [learner],
      adminIds: [admin],
      at,
    });
    await seedOrganization(database, {
      organizationId: otherSchool,
      learnerIds: [],
      adminIds: [otherAdmin],
      at,
    });
    await database
      .delete(organizationDomain)
      .where(inArray(organizationDomain.organizationId, [school, otherSchool]));
  });

  const list = (actingAs: string) =>
    listDomains({ database, baseUrl, organizationId: school, actingAs });

  test("lists every domain serving the organization, newest first, for its admin", async () => {
    expect(await list(admin)).toEqual({ domains: [], claims: [], canAdd: false });

    await register("school.braivo.example");
    await register("learn.domains-test.example");
    await register("learn.other-test.example", otherSchool);

    expect(await list(admin)).toEqual({
      // Without a provisioner, none removable.
      domains: [
        { hostname: "learn.domains-test.example", removable: false },
        { hostname: "school.braivo.example", removable: false },
      ],
      claims: [],
      canAdd: false,
    });
  });

  test("breaks a tie in registration time by hostname, as the learn domain does", async () => {
    const registeredAt = new Date("2026-01-01T00:00:00.000Z");
    await database.insert(organizationDomain).values(
      ["a.domains-test.example", "z.domains-test.example"].map((hostname) => ({
        hostname,
        organizationId: school,
        registeredAt,
      })),
    );

    expect((await list(admin)).domains.map(({ hostname }) => hostname)).toEqual([
      "z.domains-test.example",
      "a.domains-test.example",
    ]);
    expect(await readLearnDomain(database, school)).toBe("z.domains-test.example");
  });

  test("refuses a learner and another organization's admin", async () => {
    for (const actingAs of [learner, otherAdmin]) {
      await expect(list(actingAs)).rejects.toBeInstanceOf(NotPermitted);
    }
  });
});
