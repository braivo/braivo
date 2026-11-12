// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  type ListedOrganization,
  deleteNewOrganization,
  ensurePersonalOrganization,
  findToolsReadLearnerData,
  type Member,
  type Organization,
  readDomainOrganization,
  readMembers,
  readMemberships,
  readOrganizationBySlug,
  readUser,
  type ToolsReadLearnerData,
  updateOrganizationName,
  updateToolsReadLearnerData,
} from "../persistence/index.ts";
import { type AccessKind, assertMayReadLearnerData } from "./access.ts";
import { type Ai, aiEnabledFor } from "./ai.ts";
import { DomainRefused, readLearnHostname, registerLearnDomain } from "./domains.ts";
import { administers, assertMayAdminister, authors, NotPermitted } from "./permission.ts";

type OrganizationListEntry = ListedOrganization & {
  personal: boolean;
  administers: boolean;
  authors: boolean;
  teaches: boolean;
  aiEnabled?: boolean;
};

/**
 * The organizations someone works in, by name, each with where its learners
 * practise: those they administer (`owner` or `admin`), author in (those or
 * `author`, ADR 0048), or teach a group in (ADR 0042), each flag on its own.
 * Not every membership, since a learner is a member too. Those they author in
 * say whether they may use the installation's AI, so the console offers it
 * only where it works; a teacher alone learns nothing of it (generation-8).
 */
export async function listOrganizations(input: {
  database: Database;
  actingAs: string;
  ai?: Ai;
}): Promise<OrganizationListEntry[]> {
  const memberships = await readMemberships(input.database, input.actingAs);
  return memberships.flatMap(({ organization, roles, teaches }): OrganizationListEntry[] => {
    const flags = { administers: administers(roles), authors: authors(roles), teaches };
    if (flags.authors) {
      return [{ ...organization, ...flags, aiEnabled: aiEnabledFor(input.ai, organization.id) }];
    }
    return teaches ? [{ ...organization, ...flags }] : [];
  });
}

/** An organization someone is a member of, as they find it to learn there. */
type Membership = { id: string; name: string; learnDomain: string | null };

/**
 * Every organization someone is a member of, in any role, since membership is
 * enrollment (access-23), by name, each with where its learners practise: for
 * the console's `/join` to list (access-59). `listOrganizations` is
 * the console's own.
 */
export async function listMemberships(input: {
  database: Database;
  actingAs: string;
}): Promise<Membership[]> {
  const memberships = await readMemberships(input.database, input.actingAs);
  return memberships.map(({ organization: { id, name, learnDomain } }) => ({
    id,
    name,
    learnDomain,
  }));
}

/**
 * The organizations someone owns that are not personal, which self-serve
 * allows one of: owning a personal organization leaves an account free to set
 * a school up, and the reverse (ADR 0060).
 */
async function ownedNonPersonal(database: Database, userId: string) {
  return (await readMemberships(database, userId)).filter(
    ({ organization, roles }) => roles.includes("owner") && !organization.personal,
  );
}

/**
 * Whether the account's email is confirmed: a school is what another person
 * could inherit, so an unconfirmed one sets none up (ADR 0063). A personal
 * organization is the account's own, set up either way.
 */
async function emailConfirmed(database: Database, userId: string): Promise<boolean> {
  return (await readUser(database, userId))?.emailVerified === true;
}

/**
 * Whether someone may set up an organization (ADR 0018): owning no school
 * (ADR 0059), their email confirmed. An `admin` or `member` elsewhere may;
 * administering is not owning.
 */
export async function maySetUpOrganization(input: {
  database: Database;
  actingAs: string;
}): Promise<boolean> {
  return (
    (await emailConfirmed(input.database, input.actingAs)) &&
    (await ownedNonPersonal(input.database, input.actingAs)).length === 0
  );
}

/**
 * Every member of an organization, for whoever administers it, and to a tool
 * only where the organization allows it (ADR 0050). A learner may not list the
 * others: membership is not a directory of classmates.
 */
export async function listMembers(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
}): Promise<Member[]> {
  const { database, organizationId, actingAs, accessKind } = input;

  await assertMayAdminister(database, { organizationId, userId: actingAs });
  await assertMayReadLearnerData(database, { organizationId, accessKind });

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
      | "ALREADY_OWNER"
      | "EMAIL_UNCONFIRMED",
    message: string,
  ) {
    super(message);
    this.name = "SetUpRefused";
  }
}

/**
 * Service and region names no self-serve organization may take as its
 * subdomain, so none passes for the installation's own; `domains` is kept for
 * organizations' own domains to point at, `learn` for Braivo's own learn app.
 * Console routes are reserved by the slug rules (`auth/slug.ts`).
 */
const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "admin",
  "app",
  "customers",
  "demo",
  "docs",
  "domains",
  "eu",
  "help",
  "learn",
  "mail",
  "status",
  "us",
  "www",
]);

const MAX_NAME_LENGTH = 100;

/**
 * `value` trimmed, if an organization may be named so, set up or renamed: 1
 * to 100 characters, none NUL, which PostgreSQL's text cannot hold.
 */
function parseOrganizationName(value: string): string | undefined {
  const name = value.trim();
  return name !== "" && name.length <= MAX_NAME_LENGTH && !name.includes("\0") ? name : undefined;
}

/**
 * Self-serve onboarding (ADR 0018): someone owning no organization, their
 * email confirmed, creates one, its `owner`, served at `<slug>.<selfServeDomain>`. One per account, a
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
}): Promise<
  ListedOrganization & { personal: false; administers: true; authors: true; teaches: false }
> {
  const { database, actingAs, slug } = input;
  const name = parseOrganizationName(input.name);
  if (name === undefined) {
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

  if (!(await emailConfirmed(database, actingAs))) {
    throw new SetUpRefused(
      "EMAIL_UNCONFIRMED",
      "Confirm your email with a code sent there before setting up an organization.",
    );
  }
  const owns = () => ownedNonPersonal(database, actingAs);
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
  return {
    ...organization,
    learnDomain: hostname,
    // A school: a personal organization is `setUpPersonalOrganization`'s.
    personal: false,
    administers: true,
    authors: true,
    teaches: false,
  };
}

/** Lowercase letters and digits a personal organization's slug is drawn from: base32's. */
const SLUG_LETTERS = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Sets up the account's personal organization (ADR 0060, ADR 0046), or
 * answers the one it has: at most one, so a retry, or setups at once, answer
 * the same. A person's own, never a school: no learn domain, as its courses are
 * at the installation's `/c/<course ID>`, and a slug of `p-` and 16 random
 * letters (80 bits), which names it in the console and in no address a school
 * would want. Named after the account, its email while it has no name. Owning
 * a school neither stops nor counts for it.
 */
export async function setUpPersonalOrganization(input: {
  database: Database;
  actingAs: string;
  now: Date;
}): Promise<{
  organization: ListedOrganization & {
    personal: true;
    administers: true;
    authors: true;
    teaches: false;
  };
  created: boolean;
}> {
  const { database, actingAs } = input;
  const account = await readUser(database, actingAs);
  if (!account) throw new Error("A personal organization needs an account.");
  const { organization, created } = await ensurePersonalOrganization(database, {
    ownerId: actingAs,
    at: input.now,
    create: () => {
      const random = crypto.getRandomValues(new Uint8Array(16));
      const slug = `p-${Array.from(random, (byte) => SLUG_LETTERS[byte % 32]).join("")}`;
      const name = (account.name.trim() || account.email).slice(0, MAX_NAME_LENGTH);
      return { id: crypto.randomUUID(), name, slug };
    },
  });
  return {
    organization: {
      ...organization,
      learnDomain: null,
      personal: true,
      administers: true,
      authors: true,
      teaches: false,
    },
    created,
  };
}

/** A name an organization cannot have; `code` for a client to word (ADR 0035). */
export class NameRefused extends Error {
  readonly code = "NAME_INVALID";
  constructor() {
    super(`A name is 1 to ${MAX_NAME_LENGTH} characters.`);
    this.name = "NameRefused";
  }
}

/**
 * Renames an organization, by its `owner` or `admin`, to `name` as setup
 * takes one, answering the name stored. Its learn domain shows it from its
 * next load.
 */
export async function renameOrganization(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  name: string;
}): Promise<{ name: string }> {
  const { database, organizationId } = input;
  await assertMayAdminister(database, { organizationId, userId: input.actingAs });
  const name = parseOrganizationName(input.name);
  if (name === undefined) throw new NameRefused();
  const stored = await updateOrganizationName(database, { organizationId, name });
  // Deleted since the check, it is no longer theirs to rename.
  if (stored === undefined) throw new NotPermitted(`Organization ${organizationId} is gone.`);
  return { name: stored };
}

/**
 * Whether tools read the organization's learners' data (ADR 0050), who last
 * changed it, and when, for its `owner` or `admin` in a browser.
 */
export async function readToolsReadLearnerData(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
}): Promise<ToolsReadLearnerData> {
  await assertMayDecideToolsAccess(input);
  return storedToolsReadLearnerData(input.database, input.organizationId);
}

/**
 * Lets tools read the organization's learners' data, or stops them, by its
 * `owner` or `admin` in a browser, answering the setting as it then stands.
 * Recorded as their change only if it changes the value.
 */
export async function setToolsReadLearnerData(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
  allowed: boolean;
  now: Date;
}): Promise<ToolsReadLearnerData> {
  const { database, organizationId, actingAs } = input;
  await assertMayDecideToolsAccess(input);
  await updateToolsReadLearnerData(database, {
    organizationId,
    allowed: input.allowed,
    changedBy: actingAs,
    changedAt: input.now,
  });
  return storedToolsReadLearnerData(database, organizationId);
}

/**
 * Refuses, as `NotPermitted`, all but an `owner` or `admin` in a browser: a
 * tool cannot grant itself access, nor read who decided.
 */
async function assertMayDecideToolsAccess(input: {
  database: Database;
  organizationId: string;
  actingAs: string;
  accessKind: AccessKind;
}): Promise<void> {
  if (input.accessKind !== "browser") {
    throw new NotPermitted("Only a browser decides whether tools read learners' data.");
  }
  await assertMayAdminister(input.database, {
    organizationId: input.organizationId,
    userId: input.actingAs,
  });
}

/** The setting as stored; deleted since the check, the organization is no longer theirs. */
async function storedToolsReadLearnerData(
  database: Database,
  organizationId: string,
): Promise<ToolsReadLearnerData> {
  const found = await findToolsReadLearnerData(database, organizationId);
  if (!found) throw new NotPermitted(`Organization ${organizationId} is gone.`);
  return found;
}
