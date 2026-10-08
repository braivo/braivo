// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { APIError } from "better-auth/api";

import { type Auth, MEMBERSHIP_LIMIT } from "./auth.ts";

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

/** The roles the operator may give: never `owner`, which only `createOrganization` gives. */
const MEMBER_ROLES = ["member", "admin"] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];
const isMemberRole = (role: string): role is MemberRole =>
  (MEMBER_ROLES as readonly string[]).includes(role);

/**
 * Adds an existing account to an organization: the operator's command, how a
 * school's learners get in until ADR 0018's invitations. `member` is a
 * learner, enrolled in every course, since membership is enrollment; `admin`
 * also manages the organization's content. Never `owner`, nor a second
 * membership, which would leave the role unchanged.
 */
export async function addMember(
  auth: Auth,
  input: { slug: string; email: string; role: string },
): Promise<{ organization: { name: string; slug: string }; role: MemberRole }> {
  const { slug, email, role } = input;
  if (!isMemberRole(role)) {
    throw new Error(`The role must be member or admin, not "${role}".`);
  }
  const { adapter, internalAdapter } = await auth.$context;
  const organization = await adapter.findOne<{ id: string; name: string; slug: string }>({
    model: "organization",
    where: [{ field: "slug", value: slug }],
  });
  if (!organization) throw new Error(`No organization has the slug "${slug}".`);
  // Better Auth stores emails lowercased.
  const found = await internalAdapter.findUserByEmail(email.toLowerCase());
  if (!found) throw new Error(`No account uses ${email}. They sign in once, then run this again.`);

  try {
    await auth.api.addMember({
      body: { userId: found.user.id, organizationId: organization.id, role },
    });
  } catch (error) {
    const code = error instanceof APIError ? error.body?.code : undefined;
    if (code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") {
      throw new Error(`${email} is already a member of ${organization.name}.`);
    }
    if (code === "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED") {
      throw new Error(
        `${organization.name} already has ${MEMBERSHIP_LIMIT.toLocaleString("en")} members, the most an organization holds.`,
      );
    }
    throw error;
  }
  return { organization: { name: organization.name, slug: organization.slug }, role };
}
