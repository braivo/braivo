// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { organization, organizationDomain, organizationDomainClaim } from "@braivo/db/schema";
import { and, desc, eq, not, sql } from "drizzle-orm";

import type { Organization } from "./membership.ts";

/** The organization a hostname serves, or `undefined` when it serves none. */
export async function readDomainOrganization(
  database: Database,
  hostname: string,
): Promise<Organization | undefined> {
  const [row] = await database
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organizationDomain)
    .innerJoin(organization, eq(organization.id, organizationDomain.organizationId))
    .where(eq(organizationDomain.hostname, hostname));

  return row;
}

/** Newest first: the first is the one an organization's learn domain is named by. */
const NEWEST_FIRST = [desc(organizationDomain.registeredAt), desc(organizationDomain.hostname)];

/** Every hostname serving an organization, newest first. */
export async function readDomains(
  database: Database,
  organizationId: string,
): Promise<{ hostname: string }[]> {
  return database
    .select({ hostname: organizationDomain.hostname })
    .from(organizationDomain)
    .where(eq(organizationDomain.organizationId, organizationId))
    .orderBy(...NEWEST_FIRST);
}

/**
 * The hostname an organization's learn app is named by, the latest it
 * registered, or `undefined` while none serves it. Any others serve it too.
 */
export async function readLearnDomain(
  database: Database,
  organizationId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ hostname: organizationDomain.hostname })
    .from(organizationDomain)
    .where(eq(organizationDomain.organizationId, organizationId))
    .orderBy(...NEWEST_FIRST)
    .limit(1);

  return row?.hostname;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A claim not yet expired: one not activated seven days on holds nothing
 * (ADR 0038), so nobody keeps a hostname by claiming it alone.
 */
const unexpired = sql`${organizationDomainClaim.claimedAt} > now() - interval '7 days'`;

/** Who holds a hostname: the organization it serves, or one that claimed it (ADR 0038). */
export type HostnameHolder =
  | { organization: Organization; holds: "domain" }
  | { organization: Organization; holds: "claim"; claimId: number };

/**
 * Takes a hostname for the transaction, then reads who holds it, first
 * deleting an expired claim to it, which holds it no more. Every write to
 * `organization_domain` or `organization_domain_claim` takes it first, so a
 * hostname is one organization's across both tables, which no key can hold.
 */
async function lockHostname(
  transaction: Transaction,
  hostname: string,
): Promise<HostnameHolder | undefined> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`braivo:hostname:${hostname}`}, 0))`,
  );
  const fields = { id: organization.id, name: organization.name, slug: organization.slug };
  const [served] = await transaction
    .select(fields)
    .from(organizationDomain)
    .innerJoin(organization, eq(organization.id, organizationDomain.organizationId))
    .where(eq(organizationDomain.hostname, hostname));
  if (served) return { organization: served, holds: "domain" };
  await transaction
    .delete(organizationDomainClaim)
    .where(and(eq(organizationDomainClaim.hostname, hostname), not(unexpired)));
  const [claimed] = await transaction
    .select({ ...fields, claimId: organizationDomainClaim.id })
    .from(organizationDomainClaim)
    .innerJoin(organization, eq(organization.id, organizationDomainClaim.organizationId))
    .where(eq(organizationDomainClaim.hostname, hostname));
  if (!claimed) return undefined;
  const { claimId, ...claimant } = claimed;
  return { organization: claimant, holds: "claim", claimId };
}

/**
 * Maps a hostname to an organization, answering who held it instead, this
 * one included, or `undefined` when this call mapped it. The organization's
 * own claim to it gives way: whoever calls this vouches for the hostname.
 */
export async function insertLearnDomain(
  database: Database,
  input: { hostname: string; organizationId: string },
): Promise<HostnameHolder | undefined> {
  return database.transaction(async (transaction) => {
    const holder = await lockHostname(transaction, input.hostname);
    if (holder && !(holder.holds === "claim" && holder.organization.id === input.organizationId)) {
      return holder;
    }
    await transaction
      .delete(organizationDomainClaim)
      .where(eq(organizationDomainClaim.hostname, input.hostname));
    await transaction.insert(organizationDomain).values(input);
    return undefined;
  });
}

/** Every hostname an organization claimed, not yet activated nor expired, newest first, each claim's ID. */
export async function readDomainClaims(
  database: Database,
  organizationId: string,
): Promise<{ hostname: string; id: number }[]> {
  return database
    .select({ hostname: organizationDomainClaim.hostname, id: organizationDomainClaim.id })
    .from(organizationDomainClaim)
    .where(and(eq(organizationDomainClaim.organizationId, organizationId), unexpired))
    .orderBy(desc(organizationDomainClaim.claimedAt), desc(organizationDomainClaim.hostname));
}

/**
 * Claims a hostname for an organization, answering the new claim's ID, or
 * who held it instead, this one's own claim included.
 */
export async function insertDomainClaim(
  database: Database,
  input: { hostname: string; organizationId: string },
): Promise<HostnameHolder | { claimId: number }> {
  return database.transaction(async (transaction) => {
    const holder = await lockHostname(transaction, input.hostname);
    if (holder) return holder;
    // Under the hostname's lock, so a later claim to it takes a greater ID.
    const [claim] = await transaction
      .insert(organizationDomainClaim)
      .values(input)
      .returning({ id: organizationDomainClaim.id });
    if (!claim) throw new Error(`Claiming ${input.hostname} stored nothing.`);
    return { claimId: claim.id };
  });
}
