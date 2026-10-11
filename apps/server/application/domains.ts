// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { describeError } from "../logging.ts";
import {
  type HostnameHolder,
  insertDomainClaim,
  insertLearnDomain,
  type Organization,
  readDomainClaims,
  readDomains,
  readOrganizationBySlug,
} from "../persistence/index.ts";
import { assertMayAdminister } from "./permission.ts";

/**
 * Serving an organization's own hostname, supplied by the installation as it
 * supplies `sendMail` (ADR 0038): Braivo Cloud's asks Cloudflare for SaaS.
 * Every call names the claim it is for (`claim`, its ID), and a proof, and
 * whatever serves the hostname, belong to that claim alone: whatever an
 * earlier claim to the hostname left (its organization since deleted, say)
 * never answers for a later one. Claims' IDs are ordered, a later claim's to
 * a hostname greater, whatever the clocks say, so an `add` arriving late for
 * a claim older than the one the provisioner serves the hostname for is
 * ignored, answering it not ready. Each call is safe to repeat for the same
 * claim, and should settle within seconds: Braivo waits for it. A claim
 * expired (seven days on, not activated) is never named again, nor removed:
 * what the provisioner holds for it is its own to sweep.
 */
export type DomainProvisioner = {
  /**
   * Starts serving `hostname` for `claim` once proven, answering what proves
   * it; anything an earlier claim left is replaced, so the proof is made anew.
   */
  add(hostname: string, claim: number): Promise<DomainStatus>;
  /** Where `claim` to `hostname`, added before, stands. */
  status(hostname: string, claim: number): Promise<DomainStatus>;
};

export type DomainStatus = {
  /**
   * Ownership proven afresh for this claim, the hostname's traffic reaching
   * the installation, and its certificate issued: only then may it be
   * activated, to serve.
   */
  ready: boolean;
  /** What the organization creates in its DNS: pointing the hostname here, and proving it theirs. */
  records: DnsRecord[];
};

/** A DNS record, as a DNS provider's form asks for one. */
export type DnsRecord = { type: string; name: string; value: string };

/** A hostname claimed, with where it stands: `null` while the provisioner cannot say. */
export type DomainClaim = { hostname: string; status: DomainStatus | null };

/**
 * Every hostname serving an organization's learn app, newest first, the first
 * naming its learn domain, then those it claimed, newest first, with where
 * each stands, for whoever administers it. `canAdd` while the installation has
 * a provisioner to prove a claim.
 */
export async function listDomains(input: {
  database: Database;
  provisioner?: DomainProvisioner;
  organizationId: string;
  actingAs: string;
}): Promise<{ domains: { hostname: string }[]; claims: DomainClaim[]; canAdd: boolean }> {
  const { database, provisioner, organizationId, actingAs } = input;
  await assertMayAdminister(database, { organizationId, userId: actingAs });
  const [domains, claimed] = await Promise.all([
    readDomains(database, organizationId),
    readDomainClaims(database, organizationId),
  ]);
  const claims = await Promise.all(
    claimed.map(async ({ hostname, id }) => ({
      hostname,
      // One the provisioner cannot speak for stays listed, its status unknown.
      status: provisioner
        ? await provisioner.status(hostname, id).catch((error: unknown) => {
            console.error({
              message: "A claimed domain's status could not be read",
              error: describeError(error),
            });
            return null;
          })
        : null,
    })),
  );
  return { domains, claims, canAdd: provisioner !== undefined };
}

/** Whether `hostname` is the installation's: its own, or given out by setup (access-31). */
function isInstallationHostname(
  hostname: string,
  { baseUrl, selfServeDomain }: { baseUrl: string; selfServeDomain?: string },
): boolean {
  return (
    hostname === new URL(baseUrl).hostname ||
    (selfServeDomain !== undefined &&
      (hostname === selfServeDomain || hostname.endsWith(`.${selfServeDomain}`)))
  );
}

/**
 * A learn domain refused; `code` for a client to word in its language
 * (ADR 0035), the message telling an operator the same in English.
 */
export class DomainRefused extends Error {
  constructor(
    readonly code:
      | "DOMAIN_INVALID"
      | "DOMAIN_RESERVED"
      | "DOMAIN_TAKEN"
      | "ALREADY_ADDED"
      | "NO_ORGANIZATION",
    message: string,
  ) {
    super(message);
    this.name = "DomainRefused";
  }
}

/**
 * The provisioner failed or was unreachable, so asking again may work. A
 * claim it was asked to add stays, for claiming again to ask again.
 */
export class ProvisioningFailed extends Error {
  constructor(options: { cause: unknown }) {
    super("Domains could not be checked just now. Try again.", options);
    this.name = "ProvisioningFailed";
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
export function readLearnHostname(input: string): string {
  // Before lowercasing, which turns some non-ASCII letters into ASCII ones:
  // the Kelvin sign into `k`.
  if (/\P{ASCII}/u.test(input)) {
    throw new DomainRefused(
      "DOMAIN_INVALID",
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
      "DOMAIN_INVALID",
      `"${input}" cannot be a learn domain. Write a hostname such as learn.example.com: labels of letters, digits, and inner hyphens, each 1 to 63 characters, 253 in all; no scheme, port, path, trailing dot, or IP address.`,
    );
  }
  return hostname;
}

/**
 * Registers `hostname` as one of an organization's learn domains, or confirms
 * it already is, so provisioning may retry. It may be the organization's own:
 * whoever controls it reaches only that organization's learner sessions
 * (ADR 0004, ADR 0018). Newly registered, it is the one the organization's
 * learn domain is named by; those before it keep serving, so learners'
 * links and sign-ins there still work, and `<slug>.<self-serve domain>`
 * stands in when a custom domain does not.
 *
 * Never the installation's hostname, which serves every organization whatever
 * a mapping says.
 */
export async function registerLearnDomain(input: {
  database: Database;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  organizationSlug: string;
  hostname: string;
}): Promise<{ organization: Organization; hostname: string }> {
  const { database } = input;
  const hostname = readLearnHostname(input.hostname);
  if (hostname === new URL(input.baseUrl).hostname) {
    throw new DomainRefused(
      "DOMAIN_RESERVED",
      `${hostname} is this installation's own hostname, which serves every organization.`,
    );
  }
  const organization = await readOrganizationBySlug(database, input.organizationSlug);
  if (!organization) {
    throw new DomainRefused(
      "NO_ORGANIZATION",
      `No organization has the slug "${input.organizationSlug}".`,
    );
  }

  const holder = await insertLearnDomain(database, { hostname, organizationId: organization.id });
  if (holder && !(holder.holds === "domain" && holder.organization.id === organization.id)) {
    throw taken(hostname, holder);
  }
  return { organization, hostname };
}

/** `hostname` refused the operator for being another organization's, saying whose and how. */
function taken(hostname: string, { organization, holds }: HostnameHolder): DomainRefused {
  const whose = `${organization.name} (${organization.slug})`;
  return new DomainRefused(
    "DOMAIN_TAKEN",
    holds === "domain"
      ? `${hostname} already serves ${whose}.`
      : `${whose} has claimed ${hostname}.`,
  );
}

/**
 * Claims `hostname` for an organization, by its `owner` or `admin`, and asks
 * the provisioner to serve it once proven (ADR 0038), answering where it
 * stands, the DNS records to create included. Claiming it again, as a retry
 * does, asks again; one expired is replaced, proven afresh. The claim serves
 * nothing. Refused: no provisioner (the caller's to say), a malformed
 * hostname, the installation's own or one under its self-serve domain, and
 * one any organization holds, this one serving it included. A provisioner
 * failing keeps the claim.
 */
export async function claimDomain(input: {
  database: Database;
  provisioner: DomainProvisioner;
  /** `BRAIVO_URL`. */
  baseUrl: string;
  /** Whose subdomains setup gives out by slug (access-31), none to claim. */
  selfServeDomain?: string;
  organizationId: string;
  actingAs: string;
  hostname: string;
}): Promise<DomainClaim & { status: DomainStatus }> {
  const { database, provisioner, organizationId } = input;
  await assertMayAdminister(database, { organizationId, userId: input.actingAs });
  const hostname = readLearnHostname(input.hostname);
  if (isInstallationHostname(hostname, input)) {
    throw new DomainRefused("DOMAIN_RESERVED", `${hostname} is this installation's own.`);
  }

  const claimed = await insertDomainClaim(database, { hostname, organizationId });
  // Held already (a holder says how; a new claim does not): by another
  // organization, refused; served here, refused; claimed here, a retry,
  // asking again for that same claim.
  if ("holds" in claimed) {
    // Never saying whose: a member learns only that it is taken.
    if (claimed.organization.id !== organizationId) {
      throw new DomainRefused("DOMAIN_TAKEN", `${hostname} is another organization's.`);
    }
    if (claimed.holds === "domain") {
      throw new DomainRefused("ALREADY_ADDED", `${hostname} already serves this organization.`);
    }
  }
  const { claimId } = claimed;

  // Kept when this fails, not undone: a retry made meanwhile may have
  // succeeded on the same claim, and asking again is safe.
  try {
    return { hostname, status: await provisioner.add(hostname, claimId) };
  } catch (error) {
    throw new ProvisioningFailed({ cause: error });
  }
}
