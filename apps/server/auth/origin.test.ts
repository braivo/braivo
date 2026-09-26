// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import { organization, organizationDomain } from "@braivo/db/schema";
import { seedOrganization, sharedDatabase, violatedConstraint } from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { isOrganizationOrigin } from "./origin.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = sharedDatabase(connectionString ?? "");

const organizationId = "origin-test-org";
const hostname = "origin-test.example.com";
const at = new Date("2026-01-01T00:00:00.000Z");

const trusted = (origin: string) => isOrganizationOrigin(database, origin);

/** Requires TEST_DATABASE_URL: trust follows the rows the database holds. */
describe.skipIf(!connectionString)("isOrganizationOrigin", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    await seedOrganization(database, { organizationId, learnerIds: [], at });
    await database
      .insert(organizationDomain)
      .values({ hostname, organizationId })
      .onConflictDoNothing();
  });

  test("trusts an organization's domain over HTTPS", async () => {
    expect(await trusted(`https://${hostname}`)).toBe(true);
  });

  test.each([
    ["an unregistered domain", "https://elsewhere.example.com"],
    ["a subdomain of a registered one", `https://evil.${hostname}`],
    ["plain HTTP", `http://${hostname}`],
    ["another port", `https://${hostname}:8443`],
    ["a URL rather than an origin", `https://${hostname}/path`],
    ["the opaque null origin", "null"],
  ])("refuses %s", async (_case, origin) => {
    expect(await trusted(origin)).toBe(false);
  });

  test("refuses a hostname stored in capitals, which would never match", async () => {
    const refused = await database
      .insert(organizationDomain)
      .values({ hostname: "Origin-Test.example.org", organizationId })
      .catch((thrown: unknown) => thrown);

    expect(violatedConstraint(refused)).toBe("organization_domain_hostname_lowercase");
  });

  test("stops trusting a domain once its organization is gone", async () => {
    const gone = "origin-test-gone-org";
    await seedOrganization(database, { organizationId: gone, learnerIds: [], at });
    await database
      .insert(organizationDomain)
      .values({ hostname: "origin-test-gone.example.com", organizationId: gone })
      .onConflictDoNothing();

    await database.delete(organization).where(eq(organization.id, gone));

    expect(await trusted("https://origin-test-gone.example.com")).toBe(false);
  });
});
