// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { APIError } from "better-auth/api";

import { type Auth, MEMBERSHIP_LIMIT } from "./auth.ts";
import { isReservedSlug, slugProblem } from "./slug.ts";

/**
 * Creates an organization owned by an existing account: the operator's
 * command, since browsers may not create one through Better Auth (ADR 0018).
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
  const created = await createOwnedOrganization(auth, { name, slug, ownerId: owner.user.id });
  if (created === "slug taken") throw new Error(`An organization already has the slug "${slug}".`);
  if (created === "slug reserved" || created === "slug malformed") {
    throw new Error(slugProblem(slug));
  }
  return created;
}

/**
 * Creates an organization owned by `ownerId`, for the operator's command or
 * self-serve onboarding (ADR 0018). Better Auth lets a call without a session
 * through when it names the user, and runs the same hooks, so the slug rules
 * still apply.
 */
export async function createOwnedOrganization(
  auth: Auth,
  input: { name: string; slug: string; ownerId: string },
): Promise<
  { id: string; name: string; slug: string } | "slug taken" | "slug reserved" | "slug malformed"
> {
  const { name, slug, ownerId } = input;
  try {
    // Picked, since Better Auth's answer carries its members too.
    const created = await auth.api.createOrganization({ body: { name, slug, userId: ownerId } });
    return { id: created.id, name: created.name, slug: created.slug };
  } catch (error) {
    // Better Auth says "Organization already exists", which reads as though
    // this one had been created before; only the slug is known to clash.
    if (error instanceof APIError && error.body?.code === "ORGANIZATION_ALREADY_EXISTS") {
      return "slug taken";
    }
    if (error instanceof APIError && error.body?.code === "ORGANIZATION_SLUG_NOT_ALLOWED") {
      // Told apart, so that someone choosing an address hears which to fix.
      return isReservedSlug(slug) ? "slug reserved" : "slug malformed";
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
