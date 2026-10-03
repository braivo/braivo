// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import type { Database } from "@braivo/db";

import {
  deleteLearnerSession,
  insertHandoff,
  issueHandoffCode,
  readDomainOrganization,
  readHandoff,
  readLearnerSession,
  spendHandoffCode,
  renewLearnerSession,
} from "../persistence/index.ts";
import { isMember } from "./permission.ts";

// A learn domain's sign-in, handed over from the installation's origin, and
// the learner session it ends in (ADR 0018). OAuth's authorization code flow
// in miniature: the handoff is a pushed request, the nonce cookie PKCE's
// verifier, binding the code to the browser that started it.

/** Time to sign in, an emailed code included. */
const HANDOFF_SECONDS = 15 * 60;
/** A code only crosses one redirect. */
const CODE_SECONDS = 60;
/** As Better Auth's own sessions: a week, renewed by use once a day old. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;

/** 256 random bits, URL-safe. */
function secret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Stored in place of a secret, so a database leak redeems nothing. */
function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

const later = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);

/**
 * A path within the domain, or `/`: the handoff ends in a redirect there, and
 * anything a browser would read as elsewhere is an open redirect. Normalized
 * by the URL parser, then checked again: `/a/..//host` normalizes to `//host`.
 */
function returnPath(value: string | undefined): string {
  const nowhere = "https://return.invalid";
  if (!value?.startsWith("/") || !URL.canParse(value, nowhere)) return "/";
  const url = new URL(value, nowhere);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === nowhere && !path.startsWith("//") ? path : "/";
}

/**
 * Starts signing in on `hostname`, the learn domain the request came to,
 * answering the handoff's ID for the installation's `/login` and the nonce for
 * the browser to keep; nothing when the hostname serves no organization.
 */
export async function startHandoff(input: {
  database: Database;
  hostname: string;
  returnPath: string | undefined;
  now: Date;
}): Promise<{ handoffId: string; nonce: string; expiresAt: Date } | undefined> {
  const served = await readDomainOrganization(input.database, input.hostname);
  if (!served) return undefined;

  const handoffId = secret();
  const nonce = secret();
  const expiresAt = later(input.now, HANDOFF_SECONDS);
  await insertHandoff(input.database, {
    id: handoffId,
    organizationId: served.id,
    hostname: input.hostname,
    returnPath: returnPath(input.returnPath),
    nonceHash: hash(nonce),
    expiresAt,
    at: input.now,
  });
  return { handoffId, nonce, expiresAt };
}

/**
 * What a live handoff signs in to, for the page that asks: the organization's
 * name and the domain it returns to. Public, as the domain's own brand is.
 */
export async function describeHandoff(input: {
  database: Database;
  handoffId: string;
  now: Date;
}): Promise<{ organization: { name: string }; hostname: string } | undefined> {
  const found = await readHandoff(input.database, { id: input.handoffId, at: input.now });
  return found && { organization: { name: found.organization.name }, hostname: found.hostname };
}

export type CompletedHandoff =
  /** Gone, expired, or its domain no longer the organization's. */
  | { kind: "unavailable" }
  | { kind: "not-member" }
  /** Redeemable once, at `hostname`, by the browser that started it. */
  | { kind: "issued"; hostname: string; code: string };

/**
 * Completes a handoff for `userId`, signed in on the installation's origin:
 * only a member of its organization gets a code. Completing again replaces
 * the code, so a redirect that failed can be retried.
 */
export async function completeHandoff(input: {
  database: Database;
  handoffId: string;
  userId: string;
  now: Date;
}): Promise<CompletedHandoff> {
  const { database, handoffId: id, userId, now } = input;
  const found = await readHandoff(database, { id, at: now });
  if (!found) return { kind: "unavailable" };
  if (!(await isMember(database, { organizationId: found.organization.id, userId }))) {
    return { kind: "not-member" };
  }

  const code = secret();
  const issued = await issueHandoffCode(database, {
    id,
    userId,
    codeHash: hash(code),
    expiresAt: later(now, CODE_SECONDS),
    at: now,
  });
  return issued ? { kind: "issued", hostname: found.hostname, code } : { kind: "unavailable" };
}

/**
 * Redeems a handoff's code on `hostname` with the nonce its browser kept,
 * answering the new learner session's token and where to go; nothing for any
 * mismatch, which spends nothing.
 */
export async function redeemHandoff(input: {
  database: Database;
  hostname: string;
  code: string;
  nonce: string;
  now: Date;
}): Promise<{ token: string; expiresAt: Date; returnPath: string } | undefined> {
  const token = secret();
  const expiresAt = later(input.now, SESSION_SECONDS);
  const redeemed = await spendHandoffCode(input.database, {
    codeHash: hash(input.code),
    nonceHash: hash(input.nonce),
    hostname: input.hostname,
    at: input.now,
    session: { tokenHash: hash(token), expiresAt },
  });
  return redeemed && { token, expiresAt, returnPath: redeemed.returnPath };
}

/**
 * The user of the learner session `token` names, on `hostname`, and the
 * session's expiry, moved on when a day has passed since it last was. Nothing
 * once it expired or the hostname stopped serving its organization; whether
 * they are still a member is each route's to check.
 */
export async function resumeLearnerSession(input: {
  database: Database;
  hostname: string;
  token: string;
  now: Date;
}): Promise<{ user: { id: string; name: string }; renewedUntil?: Date } | undefined> {
  const { database, now } = input;
  const tokenHash = hash(input.token);
  const found = await readLearnerSession(database, {
    tokenHash,
    hostname: input.hostname,
    at: now,
  });
  if (!found) return undefined;

  if (found.expiresAt > later(now, SESSION_SECONDS - RENEW_AFTER_SECONDS)) {
    return { user: found.user };
  }
  const renewedUntil = later(now, SESSION_SECONDS);
  await renewLearnerSession(database, { tokenHash, expiresAt: renewedUntil });
  return { user: found.user, renewedUntil };
}

/** Ends the learner session `token` names, wherever it was open. */
export async function endLearnerSession(input: { database: Database; token: string }) {
  await deleteLearnerSession(input.database, hash(input.token));
}
