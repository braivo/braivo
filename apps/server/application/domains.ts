// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { describeError } from "../logging.ts";
import {
  activateDomainClaim,
  deleteDomain,
  type HostnameHolder,
  insertDomainClaim,
  insertLearnDomain,
  type Organization,
  readDomainClaim,
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
 * never answers for a later one, nor does removing it touch a later one.
 * Claims' IDs are ordered, a later claim's to a hostname greater, whatever
 * the clocks say, so an `add` arriving late for a claim older than the one
 * the provisioner serves the hostname for is ignored, answering it not ready.
 * Each call is safe to repeat for the same claim, and should settle within
 * seconds: Braivo waits for it. A claim expired (seven days on, not activated)
 * is never named again, nor removed: what the provisioner holds for it is its
 * own to sweep.
 */
export type DomainProvisioner = {
  /**
   * Starts serving `hostname` for `claim` once proven, answering what proves
   * it; anything an earlier claim left is replaced, so the proof is made anew.
   */
  add(hostname: string, claim: number): Promise<DomainStatus>;
  /** Where `claim` to `hostname`, added before, stands. */
  status(hostname: string, claim: number): Promise<DomainStatus>;
  /**
   * Stops serving `hostname` for `claim`, leaving any later claim's be.
   * Braivo stops waiting once `signal` aborts.
   */
  remove(hostname: string, claim: number, options: { signal: AbortSignal }): Promise<void>;
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
  baseUrl: string;
  selfServeDomain?: string;
  organizationId: string;
  actingAs: string;
}): Promise<{
  domains: { hostname: string; removable: boolean }[];
  claims: DomainClaim[];
  canAdd: boolean;
}> {
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
  const canAdd = provisioner !== undefined;
  return {
    // As `removeDomain` allows: with a provisioner, never the installation's
    // own, nor the last.
    domains: domains.map(({ hostname }) => ({
      hostname,
      removable: canAdd && !isInstallationHostname(hostname, input) && domains.length > 1,
    })),
    claims,
    canAdd,
  };
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
      | "NOT_CLAIMED"
      | "LAST_DOMAIN"
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
 * nothing until activated. Refused: no provisioner (the caller's to say), a
 * malformed hostname, the installation's own or one under its self-serve
 * domain, and one any organization holds, this one serving it included. A
 * provisioner failing keeps the claim.
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

/**
 * Activates an organization's claim to `hostname`, by its `owner` or `admin`,
 * once the provisioner reports it ready (ADR 0038): it serves the learn app
 * from then on, as its primary domain. Answers `active`, also for a hostname
 * that serves the organization already, left as it is, so a retry succeeds;
 * or, not ready, where it stands. Only its own claim is asked about, so no
 * organization learns where another's stands.
 */
export async function activateDomain(input: {
  database: Database;
  provisioner: DomainProvisioner;
  organizationId: string;
  actingAs: string;
  hostname: string;
}): Promise<{ active: true } | { active: false; status: DomainStatus }> {
  const { database, provisioner, organizationId } = input;
  await assertMayAdminister(database, { organizationId, userId: input.actingAs });
  const hostname = readLearnHostname(input.hostname);
  const notClaimed = new DomainRefused(
    "NOT_CLAIMED",
    `This organization has not claimed ${hostname}.`,
  );

  // The claim first, then, without it, the domains: activating removes one
  // and adds the other at once, so read in this order no activation made
  // meanwhile is missed, as reading both at once could.
  const claim = await readDomainClaim(database, { hostname, organizationId });
  if (!claim) {
    const domains = await readDomains(database, organizationId);
    if (domains.some((domain) => domain.hostname === hostname)) return { active: true };
    throw notClaimed;
  }

  let status: DomainStatus;
  try {
    status = await provisioner.status(hostname, claim.id);
  } catch (error) {
    throw new ProvisioningFailed({ cause: error });
  }
  if (!status.ready) return { active: false, status };
  // Only the claim this proof is for: one gone since, removed, expired, or
  // replaced by the operator's registration, is not activated by it; the lock
  // decides.
  const activated = await activateDomainClaim(database, {
    hostname,
    organizationId,
    claimId: claim.id,
  });
  if (activated === "unclaimed") throw notClaimed;
  return { active: true };
}

/**
 * How long removing a domain waits for the provisioner: half the 10 seconds
 * the console waits for the answer, so a removal the provisioner leaves
 * hanging usually still reaches it as done, the database's waits permitting.
 */
export const PROVISIONER_REMOVE_MS = 5_000;

/**
 * Removes a domain serving an organization, or its claim to one, by its `owner`
 * or `admin` (ADR 0038): it stops serving there and then, its learner sessions
 * deleted with it, then the provisioner is told to forget that claim, which
 * leaves any later claim to the hostname be. Its failing is logged, not
 * refused: Braivo serves the hostname no more, which is what the organization
 * asked, and what the provisioner is left holding is its own to sweep. The
 * primary falls back to the next newest. Refused: the installation's own
 * hostnames, which setup gave and which stay; the last domain serving the
 * organization; and a hostname another organization holds, as not this one's.
 */
export async function removeDomain(input: {
  database: Database;
  provisioner: DomainProvisioner;
  baseUrl: string;
  selfServeDomain?: string;
  organizationId: string;
  actingAs: string;
  hostname: string;
}): Promise<void> {
  const { database, provisioner, organizationId } = input;
  await assertMayAdminister(database, { organizationId, userId: input.actingAs });
  const hostname = readLearnHostname(input.hostname);
  if (isInstallationHostname(hostname, input)) {
    throw new DomainRefused("DOMAIN_RESERVED", `${hostname} is this installation's own; it stays.`);
  }

  const removed = await deleteDomain(database, { hostname, organizationId });
  if (removed.kind === "unheld") {
    throw new DomainRefused("NOT_CLAIMED", `This organization holds no ${hostname}.`);
  }
  if (removed.kind === "last") {
    throw new DomainRefused(
      "LAST_DOMAIN",
      `${hostname} is the only domain serving this organization; add another first.`,
    );
  }
  // Registered by the operator: never the provisioner's to forget.
  if (removed.claimId === null) return;

  // After the removal is committed, as the claim's ID keeps it from touching
  // a later claim. Bounded; caught, so a failure still answers as removed.
  const deadline = new AbortController();
  const { signal } = deadline;
  const timer = setTimeout(
    () => deadline.abort(new Error("The provisioner did not answer in time.")),
    PROVISIONER_REMOVE_MS,
  );
  // Called within the `try`, so a provisioner throwing before it returns a
  // promise is caught too.
  try {
    await Promise.race([
      provisioner.remove(hostname, removed.claimId, { signal }),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch (error) {
    console.error({
      message: "A removed domain could not be removed by the provisioner",
      hostname,
      claim: removed.claimId,
      error: describeError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
