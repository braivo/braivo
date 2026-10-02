// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { verification } from "@braivo/db/schema/auth";
import { lte } from "drizzle-orm";

/**
 * Claims sending `email` a sign-in code, which succeeds once per `seconds`.
 *
 * A row of Better Auth's `verification` table apart from the code's own, which
 * each wrong guess rewrites and a spent code loses: a cooldown kept there would
 * restart whenever an attacker spent a code. One statement, so two
 * requests at once cannot both claim it.
 */
export async function claimSignInCode(
  database: Database,
  input: { email: string; at: Date; seconds: number },
): Promise<boolean> {
  const { email, at } = input;
  const id = `sign-in-code-sent:${email}`;
  const expiresAt = new Date(at.getTime() + input.seconds * 1000);
  const claimed = await database
    .insert(verification)
    .values({ id, identifier: id, value: "", expiresAt, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: verification.id,
      set: { expiresAt, updatedAt: at },
      setWhere: lte(verification.expiresAt, at),
    })
    .returning({ id: verification.id });
  return claimed.length > 0;
}
