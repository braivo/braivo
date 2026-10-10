// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac, randomInt } from "node:crypto";

import type { Database } from "@braivo/db";
import type { Locale } from "@braivo/i18n/locales";

import { type Auth, SIGN_IN_CODE } from "../auth/index.ts";
import { describeError } from "../logging.ts";
import { type SendMail, signInCodeMail } from "../mail/index.ts";
import {
  checkLearnerSignInCode,
  nameUnnamedUser,
  readDomainOrganization,
  spendLearnerSignInCode,
  storeLearnerSignInCode,
} from "../persistence/index.ts";
import { hashToken, later, randomToken, SESSION_SECONDS } from "./learner-sessions.ts";
import { isMember } from "./permission.ts";

// Signing in on a learn domain itself, by a code sent by email (ADR 0018). The
// code is Braivo's, not Better Auth's: it opens a learner session on the
// domain it was sent for, never the account's session, so whoever controls
// the domain gains nothing by reading it. The rules are Better Auth's codes'
// (`SIGN_IN_CODE`), and so are the refusals' codes, which the shared sign-in
// form words.

/**
 * What a code is stored as: an HMAC under the installation's secret, bound to
 * where and for whom it signs in. A plain hash of six digits a database leak
 * would reverse at once; this takes the secret too.
 */
function codeDigest(input: { secret: string; hostname: string; email: string; code: string }) {
  return createHmac("sha256", input.secret)
    .update(`learner-sign-in\0${input.hostname}\0${input.email}\0${input.code}`)
    .digest("base64url");
}

export type SentLearnerCode =
  | { kind: "sent" }
  /** The hostname serves no organization. */
  | { kind: "unavailable" }
  /** One went to the address for this domain less than a minute ago. */
  | { kind: "cooldown" }
  | { kind: "send-failed" };

/**
 * Sends `email` a code that signs in on `hostname`, in `locale`, whether or
 * not it has an account or membership there: asking says nothing of either.
 * `email` is lowercased, as Better Auth's codes are.
 */
export async function sendLearnerSignInCode(input: {
  database: Database;
  /** The installation's, which `codeDigest` keys on. */
  secret: string;
  sendMail: SendMail;
  hostname: string;
  email: string;
  locale: Locale;
  now: Date;
}): Promise<SentLearnerCode> {
  const { database, hostname, now } = input;
  const email = input.email.toLowerCase();
  const served = await readDomainOrganization(database, hostname);
  if (!served) return { kind: "unavailable" };
  const code = String(randomInt(10 ** SIGN_IN_CODE.digits)).padStart(SIGN_IN_CODE.digits, "0");
  // The address's minute between codes here is this row's own: a refusal
  // means a code that works here was sent.
  const stored = await storeLearnerSignInCode(database, {
    hostname,
    email,
    organizationId: served.id,
    codeHash: codeDigest({ secret: input.secret, hostname, email, code }),
    expiresAt: later(now, SIGN_IN_CODE.seconds),
    resendAt: later(now, SIGN_IN_CODE.cooldownSeconds),
    at: now,
  });
  if (!stored) return { kind: "cooldown" };
  try {
    await input.sendMail(
      signInCodeMail({
        to: email,
        code,
        site: hostname,
        expiresInMinutes: SIGN_IN_CODE.seconds / 60,
        locale: input.locale,
      }),
    );
  } catch (error) {
    // Described, as the mail transport's error may name the recipient.
    console.error({
      message: "A learn domain's sign-in code could not be sent",
      error: describeError(error),
    });
    return { kind: "send-failed" };
  }
  return { kind: "sent" };
}

export type LearnerSignIn =
  | { kind: "signed-in"; token: string; expiresAt: Date; user: { id: string; name: string } }
  | { kind: "wrong" }
  | { kind: "expired" }
  | { kind: "guessed-out" }
  /** Right, but the account is not a member there: the code stays good, to try again once added. */
  | { kind: "not-member" };

/**
 * Signs `email` in on `hostname` with `code`, making its account, verified,
 * if there is none, as Better Auth's code sign-in does: the operator adds
 * members by an account's email (access-21). A member gets a learner session
 * there; the code is spent then and only then.
 */
export async function signInLearner(input: {
  database: Database;
  auth: Auth;
  /** The installation's, which `codeDigest` keys on. */
  secret: string;
  hostname: string;
  email: string;
  code: string;
  now: Date;
}): Promise<LearnerSignIn> {
  const { database, hostname, now } = input;
  const email = input.email.toLowerCase();
  const codeHash = codeDigest({ secret: input.secret, hostname, email, code: input.code });
  const checked = await checkLearnerSignInCode(database, {
    hostname,
    email,
    codeHash,
    attempts: SIGN_IN_CODE.attempts,
    at: now,
  });
  if (checked.kind !== "right") return checked;

  const { user } = await input.auth.api.verifiedAccount({ body: { email } });
  const { organizationId } = checked;
  if (!(await isMember(database, { organizationId, userId: user.id }))) {
    return { kind: "not-member" };
  }

  const token = randomToken();
  const expiresAt = later(now, SESSION_SECONDS);
  const spent = await spendLearnerSignInCode(database, {
    hostname,
    email,
    organizationId,
    codeHash,
    attempts: SIGN_IN_CODE.attempts,
    userId: user.id,
    at: now,
    session: { tokenHash: hashToken(token), expiresAt },
  });
  // Spent, guessed out, or expired meanwhile, or the domain moved: as if gone.
  if (!spent) return { kind: "expired" };
  return { kind: "signed-in", token, expiresAt, user: { id: user.id, name: user.name } };
}

/**
 * Names the learner's account, signed in on a learn domain, only while it has
 * none: the sign-in's last step for a new account. A learn domain renames no
 * one, as the name is the account's everywhere. Answers whether it did.
 */
export async function nameNewLearner(input: {
  database: Database;
  userId: string;
  name: string;
  now: Date;
}): Promise<boolean> {
  return nameUnnamedUser(input.database, { userId: input.userId, name: input.name, at: input.now });
}
