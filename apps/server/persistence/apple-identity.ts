// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database, Transaction } from "@braivo/db";
import { appleLink } from "@braivo/db/schema";
import { account, user } from "@braivo/db/schema/auth";
import { and, eq, gt, lte, ne } from "drizzle-orm";

import { endAccountAccess } from "./account-access.ts";

/** An Apple identity's row, as revoking its kept token needs it. */
export type AppleIdentity = {
  refreshToken: string | null;
  refreshTokenClientId: string | null;
};

const identityColumns = {
  refreshToken: account.refreshToken,
  refreshTokenClientId: account.refreshTokenClientId,
};

/**
 * Keeps `subject` the account's one Apple identity (ADR 0063), under the
 * account's row lock, so bindings at once serialize: linking it first if
 * `link` is given, then deleting any other and, in the same transaction,
 * every other way into the account but the session `keep`
 * (`endAccountAccess`): a replacement never commits without its cleanup.
 * `kept` false if the account is gone, or `subject` is not its identity
 * (unlinked meanwhile, or linked to another account): the caller then
 * refuses what it was doing. `replaced` are the identities deleted, whose
 * tokens the caller revokes once this has committed.
 */
export async function keepOneAppleIdentity(
  database: Database | Transaction,
  input: {
    userId: string;
    subject: string;
    link?: { refreshToken: string | null; refreshTokenClientId: string | null };
    keep?: string;
    at: Date;
  },
): Promise<{ kept: boolean; replaced: AppleIdentity[] }> {
  const { userId, subject, link, keep, at } = input;
  return database.transaction(async (transaction) => {
    const [held] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!held) return { kept: false, replaced: [] };
    if (link) {
      await transaction
        .insert(account)
        .values({
          id: crypto.randomUUID(),
          accountId: subject,
          providerId: "apple",
          userId,
          refreshToken: link.refreshToken,
          refreshTokenClientId: link.refreshTokenClientId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing();
    }
    const ofApple = and(eq(account.userId, userId), eq(account.providerId, "apple"));
    const [own] = await transaction
      .select({ id: account.id })
      .from(account)
      .where(and(ofApple, eq(account.accountId, subject)));
    if (!own) return { kept: false, replaced: [] };
    const replaced = await transaction
      .delete(account)
      .where(and(ofApple, ne(account.accountId, subject)))
      .returning(identityColumns);
    if (replaced.length > 0) await endAccountAccess(transaction, { userId, keep });
    return { kept: true, replaced };
  });
}

/** The Apple identities linked to `userId`'s account, with the tokens they keep. */
export function readAppleIdentities(database: Database, userId: string): Promise<AppleIdentity[]> {
  return database
    .select(identityColumns)
    .from(account)
    .where(and(eq(account.providerId, "apple"), eq(account.userId, userId)));
}

/**
 * Keeps `refreshToken`, encrypted, as the Apple identity `subject`'s, beside
 * the client ID it was issued to, replacing the one kept.
 */
export async function keepAppleRefreshToken(
  database: Database,
  input: { subject: string; refreshToken: string; clientId: string; at: Date },
): Promise<void> {
  await database
    .update(account)
    .set({
      refreshToken: input.refreshToken,
      refreshTokenClientId: input.clientId,
      updatedAt: input.at,
    })
    .where(and(eq(account.providerId, "apple"), eq(account.accountId, input.subject)));
}

/** Whether an Apple identity is linked to any account. */
export async function isAppleIdentityLinked(database: Database, subject: string): Promise<boolean> {
  return (
    (await database.$count(
      account,
      and(eq(account.providerId, "apple"), eq(account.accountId, subject)),
    )) > 0
  );
}

/** A link waiting for its code (ADR 0063): the verified identity, and its authorization if exchanged. */
export type PendingAppleLink = {
  email: string;
  subject: string;
  /** Encrypted, as an account keeps it. */
  refreshToken: string | null;
  refreshTokenClientId: string | null;
  name: string;
};

const linkColumns = {
  email: appleLink.email,
  subject: appleLink.subject,
  refreshToken: appleLink.refreshToken,
  refreshTokenClientId: appleLink.refreshTokenClientId,
  name: appleLink.name,
};

/** Stores a link waiting for its code, by its ID's hash, until `expiresAt`. */
export async function storeAppleLink(
  database: Database,
  input: { hash: string; link: PendingAppleLink; expiresAt: Date },
): Promise<void> {
  await database
    .insert(appleLink)
    .values({ idHash: input.hash, ...input.link, expiresAt: input.expiresAt });
}

/** Spends the live link with `hash`, once: one statement, so of two claims at once one wins. */
export async function claimAppleLink(
  database: Database | Transaction,
  input: { hash: string; at: Date },
): Promise<PendingAppleLink | undefined> {
  const [row] = await database
    .delete(appleLink)
    .where(and(eq(appleLink.idHash, input.hash), gt(appleLink.expiresAt, input.at)))
    .returning(linkColumns);
  return row;
}

/** Deletes and answers the links lapsed by `at`, each once. */
export function claimLapsedAppleLinks(database: Database, at: Date): Promise<PendingAppleLink[]> {
  return database.delete(appleLink).where(lte(appleLink.expiresAt, at)).returning(linkColumns);
}

/** Deletes and answers the links naming `email`, each once. */
export function claimAppleLinksFor(database: Database, email: string): Promise<PendingAppleLink[]> {
  return database.delete(appleLink).where(eq(appleLink.email, email)).returning(linkColumns);
}

/** Whether a live link holds `subject`. */
export async function hasLiveAppleLink(
  database: Database,
  input: { subject: string; at: Date },
): Promise<boolean> {
  return (
    (await database.$count(
      appleLink,
      and(eq(appleLink.subject, input.subject), gt(appleLink.expiresAt, input.at)),
    )) > 0
  );
}
