// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "@tanstack/react-router";

/** The part of a Better Auth client checking a session uses. */
export type SessionAuth<User> = {
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
 * a session can end in another tab.
 */
export async function requireSession<User>(
  auth: SessionAuth<User>,
  location: { href: string },
): Promise<{ user: User }> {
  const { data, error } = await auth.getSession();
  if (error) throw new Error(error.message ?? "Could not check whether you are signed in.");
  if (!data) throw redirect({ to: "/login", search: { redirect: location.href } });
  return { user: data.user };
}
