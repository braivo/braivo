// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { APIError } from "better-auth/api";

import type { Auth } from "./auth.ts";

/**
 * Creates an organization owned by an existing account: the operator's
 * command, since browsers may not create one (ADR 0018). Better Auth lets a
 * call without a session through when it names the user, and runs the same
 * hooks, so the slug rules still apply.
 */
export async function createOrganization(
  auth: Auth,
  input: { name: string; slug: string; ownerEmail: string },
): Promise<{ id: string; name: string; slug: string }> {
  // Better Auth stores emails lowercased.
  const { internalAdapter } = await auth.$context;
  const owner = await internalAdapter.findUserByEmail(input.ownerEmail.toLowerCase());
  if (!owner) {
    throw new Error(`No account uses ${input.ownerEmail}. They sign in once, then run this again.`);
  }
  const { name, slug } = input;
  try {
    return await auth.api.createOrganization({ body: { name, slug, userId: owner.user.id } });
  } catch (error) {
    // Better Auth says "Organization already exists", which reads as though
    // this one had been created before; only the slug is known to clash.
    if (error instanceof APIError && error.body?.code === "ORGANIZATION_ALREADY_EXISTS") {
      throw new Error(`An organization already has the slug "${slug}".`);
    }
    throw error;
  }
}
