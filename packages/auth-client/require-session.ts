// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "@tanstack/react-router";

/** The part of a Better Auth client checking a session uses. */
export type SessionAuth<User extends { name: string }> = {
  getSession(): Promise<{
    data: { user: User } | null;
    error: { message?: string } | null;
  }>;
};

/**
 * The signed-in user, or a redirect to `/login` that brings them back to
 * `location` afterwards. For a layout route's `beforeLoad`, so that no page
 * under it asks Braivo anything on behalf of nobody.
 *
 * Asks Better Auth on every navigation rather than trusting a cached answer:
 * a session can end in another tab. An account without a name goes to `/login`
 * too, which asks for one first (ADR 0018): an emailed code makes accounts
 * without one, and leaving before naming it must not skip that.
 */
export async function requireSession<User extends { name: string }>(
  auth: SessionAuth<User>,
  location: { href: string },
): Promise<{ user: User }> {
  const { data, error } = await auth.getSession();
  if (error) throw new Error(error.message ?? "Could not check whether you are signed in.");
  if (!data?.user.name.trim()) {
    throw redirect({ to: "/login", search: { redirect: location.href } });
  }
  return { user: data.user };
}

/**
 * Whether a session is open for an account still without a name, so `/login`
 * starts by asking for it. A session that cannot be checked counts as none:
 * signing in again is how to find out.
 */
export async function needsName<User extends { name: string }>(
  auth: SessionAuth<User>,
): Promise<boolean> {
  const { data } = await auth.getSession().catch(() => ({ data: null }));
  return data !== null && data.user.name.trim() === "";
}
