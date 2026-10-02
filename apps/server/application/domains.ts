// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import {
  insertLearnDomain,
  type Organization,
  readDomainOrganization,
  readLearnDomain,
  readOrganizationBySlug,
} from "../persistence/index.ts";

/**
 * A learn domain refused as malformed, taken, or for no organization; the
 * message tells the operator which.
 */
export class DomainRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRefused";
  }
}

/** A DNS label: letters, digits, and hyphens between them, at most 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

/**
 * `input` spelled as `URL#hostname` gives it, which requests are looked up by;
 * any other spelling would be stored and never match. Public DNS is not
 * required: a self-hosted operator may serve `training` from internal DNS.
 */
function readHostname(input: string): string {
  // Before lowercasing, which turns some non-ASCII letters into ASCII ones:
  // the Kelvin sign into `k`.
  if (/\P{ASCII}/u.test(input)) {
    throw new DomainRefused(
      `"${input}" is not ASCII. Write an internationalized domain name in its xn-- form.`,
    );
  }
  const hostname = input.toLowerCase();
  const labels = hostname.split(".");
  const named =
    hostname.length <= MAX_HOSTNAME_LENGTH &&
    labels.every((label) => LABEL.test(label)) &&
    // A number last makes the name an IPv4 address to URLs.
    !/^\d+$/.test(labels.at(-1) ?? "") &&
    // Catches what the labels allow and URLs refuse or rewrite: `0x1f` last,
    // which they also read as a number, and malformed `xn--` labels.
    URL.parse(`https://${hostname}`)?.hostname === hostname;
  if (!named) {
    throw new DomainRefused(
      `"${input}" cannot be a learn domain. Write a hostname such as learn.example.com: labels of letters, digits, and inner hyphens, each 1 to 63 characters, 253 in all; no scheme, port, path, trailing dot, or IP address.`,
    );
  }
  return hostname;
}

/**
 * Registers `hostname` as an organization's learn domain, or confirms it
 * already is, so provisioning may retry. Until learn domains hold sessions of
 * their own, only a hostname the operator controls is safe (ADR 0004).
 *
 * Never the installation's hostname, which serves every organization whatever
 * a mapping says, and never a replacement: learners' links and sign-ins are on
 * the current one.
 */
export async function registerLearnDomain(input: {
  database: Database;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  organizationSlug: string;
  hostname: string;
}): Promise<{ organization: Organization; hostname: string }> {
  const { database } = input;
  const hostname = readHostname(input.hostname);
  if (hostname === new URL(input.baseUrl).hostname) {
    throw new DomainRefused(
      `${hostname} is this installation's own hostname, which serves every organization.`,
    );
  }
  const organization = await readOrganizationBySlug(database, input.organizationSlug);
  if (!organization) {
    throw new DomainRefused(`No organization has the slug "${input.organizationSlug}".`);
  }

  if (await insertLearnDomain(database, { hostname, organizationId: organization.id })) {
    return { organization, hostname };
  }

  // A mapping already there refused it: this one, the hostname's elsewhere, or
  // the organization's other domain.
  const served = await readDomainOrganization(database, hostname);
  if (served?.id === organization.id) return { organization, hostname };
  if (served) {
    throw new DomainRefused(`${hostname} already serves ${served.name} (${served.slug}).`);
  }
  const current = await readLearnDomain(database, organization.id);
  if (current) {
    throw new DomainRefused(
      `${organization.name} is already served at ${current}; an organization has one learn domain.`,
    );
  }
  // Removed between the insert and the reads.
  throw new Error(`Could not register ${hostname}; try again.`);
}
