// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

import { defineRequestState } from "@better-auth/core/context";
import type { Database } from "@braivo/db";
import { APIError, type createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { describeError } from "../logging.ts";
import {
  type AppleIdentity,
  claimAppleLink,
  claimAppleLinksFor,
  claimLapsedAppleLinks,
  hasLiveAppleLink,
  isAppleIdentityLinked,
  keepOneAppleIdentity,
  nameUnnamedUser,
  type PendingAppleLink,
  readAppleIdentities,
  storeAppleLink,
} from "../persistence/index.ts";
import {
  type AppleConfig,
  exchangeAppleCode,
  isAppleEmailVerified,
  revokeAppleToken,
} from "./apple.ts";

// An Apple identity bound to an account (ADR 0063): one per account, and
// linked by a code to an account that already holds its email.

/** What a Better Auth hook is given. */
type AuthContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export type AppleOptions = { database: Database; secret: string; apple?: AppleConfig };

/** How long a link waits for its code: a code's own ten minutes (ADR 0063). */
const APPLE_LINK_SECONDS = 600;

const hashOf = (value: string) => createHash("sha256").update(value).digest("base64url");

/**
 * Revokes the Apple authorization a row keeps, if any: best effort, as what
 * removes the row goes on either way. Whether Apple accepted it; `false` with
 * no token kept.
 */
export async function revokeKeptAppleToken(
  options: { secret: string; apple?: AppleConfig },
  row: { refreshToken?: string | null; refreshTokenClientId?: string | null },
): Promise<boolean> {
  if (!row.refreshToken || !row.refreshTokenClientId) return false;
  if (!options.apple) {
    console.warn("[Apple] An Apple token is kept, but Apple is not configured to revoke it.");
    return false;
  }
  // Under another secret since, it cannot be read: as if none were kept.
  const refreshToken = await symmetricDecrypt({
    key: options.secret,
    data: row.refreshToken,
  }).catch(() => undefined);
  if (!refreshToken) {
    console.warn(
      "[Apple] A kept Apple token is unreadable under the current secret; it was not revoked.",
    );
    return false;
  }
  return revokeAppleToken(options.apple, { clientId: row.refreshTokenClientId, refreshToken });
}

/**
 * Keeps `subject` the account's one Apple identity, linking it first if
 * `link` is given (`keepOneAppleIdentity`): any other is unlinked, its token
 * revoked, and every other way into the account ended but `keep`, the
 * session just made. Links go before sessions, which an Apple sign-in in
 * flight relies on. Whether `subject` is the account's identity now.
 */
export async function bindAppleIdentity(
  options: AppleOptions,
  input: {
    userId: string;
    subject: string;
    keep?: string;
    link?: { refreshToken: string | null; refreshTokenClientId: string | null };
  },
): Promise<boolean> {
  const { kept, replaced } = await keepOneAppleIdentity(options.database, {
    userId: input.userId,
    subject: input.subject,
    link: input.link,
    keep: input.keep,
    at: new Date(),
  });
  await revokeReplaced(options, replaced);
  return kept;
}

async function revokeReplaced(options: AppleOptions, replaced: AppleIdentity[]) {
  for (const row of replaced) await revokeKeptAppleToken(options, row);
}

/**
 * Revokes a link's authorization once nothing holds it (ADR 0063): unless its
 * identity is linked to an account now, or another live link holds it, whose
 * authorization revoking this would end too (`held`). `not revoked` when no
 * token was kept, or Apple refused, or could not be asked.
 */
async function releaseLink(
  options: AppleOptions,
  link: PendingAppleLink,
): Promise<"revoked" | "held" | "not revoked"> {
  if (await isAppleIdentityLinked(options.database, link.subject)) return "held";
  if (await hasLiveAppleLink(options.database, { subject: link.subject, at: new Date() })) {
    return "held";
  }
  const accepted = await revokeKeptAppleToken(options, link);
  return accepted ? "revoked" : "not revoked";
}

/**
 * Revokes the lapsed links' authorizations, when a link is made or spent:
 * there are no jobs to do it on time (ADR 0046), so an idle installation
 * keeps a lapsed one, encrypted, until then.
 */
async function sweepLapsedLinks(options: AppleOptions): Promise<void> {
  for (const link of await claimLapsedAppleLinks(options.database, new Date())) {
    await releaseLink(options, link);
  }
}

/**
 * Answers an Apple sign-in Better Auth refused as `account not linked`, an
 * address Apple does not control that another account holds, with a link to
 * make by a code to that address (ADR 0063): `401 APPLE_LINK_REQUIRED`
 * `{ linkId, email }`, Better Auth keeping its refusal's status when an after
 * hook replaces its body. The token is verified by then, Better Auth refusing
 * so only after verifying it. Apple's own `email_verified`, which the mapping
 * already requires of an identity not linked, is checked again here: no link
 * goes to an address Apple has not verified. The code is exchanged first, so
 * the link holds the authorization too.
 */
export async function refuseWithAppleLink(
  options: AppleOptions,
  input: {
    claims: Record<string, unknown>;
    code: string | undefined;
    name: string;
  },
): Promise<undefined> {
  const { claims } = input;
  if (!isAppleEmailVerified(claims)) return;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return;
  const email = claims.email.toLowerCase();
  const clientId = typeof claims.aud === "string" ? claims.aud : null;
  const refreshToken =
    options.apple && input.code && clientId
      ? await exchangeAppleCode(options.apple, {
          clientId,
          code: input.code,
          subject: claims.sub,
        })
      : undefined;
  const linkId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const at = new Date();
  await storeAppleLink(options.database, {
    hash: hashOf(linkId),
    link: {
      email,
      subject: claims.sub,
      refreshToken: refreshToken
        ? await symmetricEncrypt({ key: options.secret, data: refreshToken })
        : null,
      refreshTokenClientId: refreshToken ? clientId : null,
      name: input.name,
    },
    expiresAt: new Date(at.getTime() + APPLE_LINK_SECONDS * 1000),
  });
  // Only now, the new link stored: a lapsed one of the same identity, an
  // ordinary retry, is then held by it and not revoked, which would end the
  // authorization just exchanged too.
  await sweepLapsedLinks(options);
  throw new APIError("UNAUTHORIZED", {
    code: "APPLE_LINK_REQUIRED",
    message: "An account already uses this email. Enter the code sent there to link Apple to it.",
    linkId,
    email,
  });
}

/** The link a code sign-in carries, kept from the raw body for the after hook. */
const appleLinkId = defineRequestState((): string | undefined => undefined);

/** Before a code sign-in: takes `appleLinkId` out of the body, which Better Auth has no place for. */
export async function takeAppleLinkId(body: unknown): Promise<void> {
  const raw = body as Record<string, unknown> | undefined;
  if (typeof raw?.appleLinkId === "string") await appleLinkId.set(raw.appleLinkId);
  if (raw) delete raw.appleLinkId;
}

/**
 * After a successful code sign-in carrying a link: links its Apple identity
 * to the account, if the link is live and for this email, with no second
 * Apple sheet (ADR 0063). The code proved the mailbox, so the sign-in stands
 * whatever happens here, saying `appleLinked`. The link is claimed and bound
 * in one transaction, so no sweep meanwhile finds its authorization held by
 * nothing, and a failure leaves the link pending as it was, to lapse.
 */
export async function linkAppleByCode(options: AppleOptions, context: AuthContext) {
  const linkId = await appleLinkId.get();
  if (linkId === undefined) return;
  const returned = context.context.returned as {
    token?: unknown;
    user?: { id?: unknown; email?: unknown; name?: unknown };
  };
  const user = returned?.user;
  if (typeof user?.id !== "string" || typeof returned.token !== "string") return;
  const userId = user.id;
  const keep = returned.token;
  let outcome: { link?: PendingAppleLink; kept: boolean; replaced: AppleIdentity[] };
  try {
    outcome = await options.database.transaction(async (transaction) => {
      const link = await claimAppleLink(transaction, { hash: hashOf(linkId), at: new Date() });
      if (!link || link.email !== user.email) return { link, kept: false, replaced: [] };
      const bound = await keepOneAppleIdentity(transaction, {
        userId,
        subject: link.subject,
        link,
        keep,
        at: new Date(),
      });
      return { link, ...bound };
    });
  } catch (error) {
    console.warn(`[Apple] Linking by code failed; the sign-in stands: ${describeError(error)}`);
    return context.json({ ...returned, appleLinked: false });
  }
  const { link, kept, replaced } = outcome;
  await revokeReplaced(options, replaced);
  if (link && !kept) await releaseLink(options, link);
  // An account with no name takes Apple's, which the answer then says.
  const named =
    link !== undefined &&
    kept &&
    link.name !== "" &&
    (await nameUnnamedUser(options.database, { userId, name: link.name, at: new Date() }));
  await sweepLapsedLinks(options);
  return context.json({
    ...returned,
    user: named ? { ...user, name: link.name } : user,
    appleLinked: kept,
  });
}

/**
 * Erasure's first step (ADR 0062): revokes at Apple every authorization the
 * account keeps, and those of links waiting for a code to its address,
 * account or none. `none` with neither; `not revoked` if any identity or
 * link has no token kept, or Apple refused, or Apple or the secret is not
 * configured here, for the person to remove the app themselves.
 */
export async function revokeAppleAuthorizationsOf(
  options: { database: Database; secret?: string; apple?: AppleConfig },
  target: { userId: string | null; email: string },
): Promise<"none" | "revoked" | "not revoked"> {
  const { secret } = options;
  const outcomes: boolean[] = [];
  // Links waiting for a code to the address, each claimed, then released: one
  // still held by its identity's account or another live link is not this
  // erasure's to revoke, and counts as done.
  for (const link of await claimAppleLinksFor(options.database, target.email)) {
    const released =
      secret === undefined ? "not revoked" : await releaseLink({ ...options, secret }, link);
    outcomes.push(released !== "not revoked");
  }
  if (target.userId !== null) {
    for (const row of await readAppleIdentities(options.database, target.userId)) {
      outcomes.push(
        secret !== undefined && (await revokeKeptAppleToken({ ...options, secret }, row)),
      );
    }
  }
  if (outcomes.length === 0) return "none";
  return outcomes.every(Boolean) ? "revoked" : "not revoked";
}
