// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type ListedOrganization,
  deleteNewOrganization,
  type Member,
  type Organization,
  readDomainOrganization,
  readMembers,
  readMemberships,
  readOrganizationBySlug,
} from "../persistence/index.ts";
import { DomainRefused, readLearnHostname, registerLearnDomain } from "./domains.ts";
import { administers, assertMayAdminister } from "./permission.ts";

/**
 * The organizations someone manages (`owner` or `admin`), by name, each with
 * where its learners practise: the console's list. Not every membership, since
 * a learner is a member too.
 */
export async function listManagedOrganizations(input: {
  database: Database;
  actingAs: string;
}): Promise<ListedOrganization[]> {
  const memberships = await readMemberships(input.database, input.actingAs);
  return memberships.filter(({ roles }) => administers(roles)).map((m) => m.organization);
}

/**
 * Every member of an organization, for whoever administers it. A learner may
 * not list the others: membership is not a directory of classmates.
 */
export async function listMembers(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
}): Promise<Member[]> {
  const { database, organizationId, actingAs } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });

  return readMembers(database, organizationId);
}

/**
 * Why an organization was not set up: `code` for a client to word it in its
 * language (ADR 0035), `message` the same in English, for any other caller.
 */
export class SetUpRefused extends Error {
  constructor(
    readonly code:
      | "NAME_INVALID"
      | "ADDRESS_INVALID"
      | "ADDRESS_RESERVED"
      | "ADDRESS_TAKEN"
      | "ALREADY_OWNER",
    message: string,
  ) {
    super(message);
    this.name = "SetUpRefused";
  }
}

/** Subdomains of `selfServeDomain` that are Braivo's own: marketing's, and its demo learn app (ADR 0004). */
const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set(["www", "demo"]);

const MAX_NAME_LENGTH = 100;

/**
 * Self-serve onboarding (ADR 0018): someone owning no organization creates
 * one, its `owner`, served at `<slug>.<selfServeDomain>`. One per account, a
 * limit of this path alone, not a defence against squatting; more take the
 * operator.
 *
 * `create` is Better Auth's creation, passed in since `application` never
 * imports `auth`; its hooks hold the slug rules. What can be checked is,
 * before creating, so a refusal leaves nothing behind; a failure after
 * creating is undone, as far as the database allows (below).
 */
export async function setUpOrganization(input: {
  database: Database;
  baseUrl: string;
  selfServeDomain: string;
  actingAs: string;
  name: string;
  slug: string;
  create: (organization: {
    name: string;
    slug: string;
    ownerId: string;
  }) => Promise<Organization | "slug taken" | "slug reserved" | "slug malformed">;
}): Promise<ListedOrganization> {
  const { database, actingAs, slug } = input;
  const name = input.name.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    throw new SetUpRefused("NAME_INVALID", `A name is 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  const hostname = `${slug}.${input.selfServeDomain}`;
  const taken = new SetUpRefused("ADDRESS_TAKEN", `${hostname} is taken. Choose another address.`);
  const invalid = new SetUpRefused(
    "ADDRESS_INVALID",
    `${hostname} is not a valid address. Use lowercase letters, digits, and single hyphens between them.`,
  );
  const reserved = new SetUpRefused(
    "ADDRESS_RESERVED",
    `${hostname} is reserved. Choose another address.`,
  );
  const alreadyOwns = new SetUpRefused(
    "ALREADY_OWNER",
    "You already own an organization. Reload this page to open it.",
  );
  if (RESERVED_SUBDOMAINS.has(slug)) throw reserved;
  try {
    readLearnHostname(hostname);
  } catch (error) {
    if (error instanceof DomainRefused) throw invalid;
    throw error;
  }

  const owns = async () =>
    (await readMemberships(database, actingAs)).filter(({ roles }) => roles.includes("owner"));
  if ((await owns()).length > 0) throw alreadyOwns;
  if (
    hostname === new URL(input.baseUrl).hostname ||
    (await readDomainOrganization(database, hostname))
  ) {
    throw taken;
  }

  const organization = await input
    .create({ name, slug, ownerId: actingAs })
    .catch(async (error: unknown) => {
      // Better Auth's error does not say why; a slug existing now is treated
      // as taken, by another setup after Better Auth looked. Better Auth writes
      // the owner apart from the organization, so a database failing between
      // the two leaves a memberless one of this setup's holding the slug, for
      // the operator.
      if (await readOrganizationBySlug(database, slug)) return "slug taken" as const;
      throw error;
    });
  if (organization === "slug taken") throw taken;
  if (organization === "slug reserved") throw reserved;
  if (organization === "slug malformed") throw invalid;
  // Whatever stops it now undoes it, the organization holding nothing yet, so
  // a retry starts clean and none stays without its address (ADR 0018); only
  // a database failing the undo too leaves one, for the operator.
  try {
    // Checked again rather than locked (ADR 0018): of one account's setups
    // made at once, each later one sees an earlier one's and undoes its own.
    // At most one stays; at worst none.
    if ((await owns()).length > 1) throw alreadyOwns;
    await registerLearnDomain({
      database,
      baseUrl: input.baseUrl,
      organizationSlug: organization.slug,
      hostname,
    });
  } catch (error) {
    await deleteNewOrganization(database, organization.id);
    // Registered for another since the check.
    throw error instanceof DomainRefused ? taken : error;
  }
  return { ...organization, learnDomain: hostname };
}
