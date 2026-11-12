// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";

import { readUserByEmail } from "../persistence/index.ts";

// An account Apple made on an address Apple does not control has an
// unconfirmed email (ADR 0063): it reaches nothing that an email names, nor
// anything another person could inherit, until a code sent there, or a token
// from a provider that controls the mailbox, confirms it.

/** The operator's refusal: whoever asks by email may not be who made the account. */
export const unconfirmedEmailMessage = (email: string) =>
  `${email} is unconfirmed: Sign in with Apple made its account, and no code sent to it has been entered since. Nothing was changed. Once its holder signs in with a code sent there, run this again.`;

/**
 * The account `email` names, for the operator's commands that find one by
 * email; refused if its email is unconfirmed, `undefined` if there is none.
 */
export async function readConfirmedUserIdByEmail(
  database: Database,
  email: string,
): Promise<string | undefined> {
  const found = await readUserByEmail(database, email);
  if (found && !found.emailVerified) throw new Error(unconfirmedEmailMessage(email));
  return found?.id;
}
