// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import { ModeToggle } from "@braivo/ui";
import { Button } from "@braivo/ui/components/button";
import { createFileRoute, Link, Outlet, useMatch, useRouter } from "@tanstack/react-router";
import { SparkleIcon } from "lucide-react";
import { useState } from "react";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";

/**
 * Everything a content owner sees once signed in. Checked before any child
 * loads, so no page asks Braivo anything on behalf of nobody.
 */
export const Route = createFileRoute("/_signed-in")({
  // Unanswered in time, as unanswered at all, the page fails and offers Try again.
  beforeLoad: ({ context, location, abortController }) =>
    requireSession(
      {
        getSession: () =>
          context.auth.getSession({
            fetchOptions: { signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS) },
          }),
      },
      location,
    ),
  component: SignedIn,
});

function SignedIn() {
  const { auth, user } = Route.useRouteContext();
  const router = useRouter();
  // Shown on each of its pages, so someone managing several sees which one they act on.
  const organization = useMatch({ from: "/_signed-in/$organizationSlug", shouldThrow: false })
    ?.context.organization;

  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFailed(false);
    // Better Auth answers a refusal as `error`, and throws when unreachable or out of time.
    const { error } = await auth
      .signOut({ fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
      .catch(() => ({ error: true }));
    if (error) {
      // Not assumed signed out, so the page stays; clicking again retries.
      setFailed(true);
      setSigningOut(false);
      return;
    }
    // Runs the check above again, which now sends the owner to sign in.
    await router.invalidate();
  }

  return (
    <>
      <header className="mb-6">
        {/* Wrapping, so at 320px the account's controls go below, never off screen. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <nav className="flex items-center gap-2 font-semibold">
            <SparkleIcon aria-hidden="true" className="mr-1 size-5 shrink-0 text-primary" />
            <Link to="/organizations">Organizations</Link>
            {organization && (
              <>
                <span aria-hidden>/</span>
                <Link to="/$organizationSlug" params={{ organizationSlug: organization.slug }}>
                  {organization.name}
                </Link>
              </>
            )}
          </nav>
          <span className="flex min-w-0 items-center gap-4">
            <span className="wrap-anywhere">{user.name}</span>
            <ModeToggle />
            {/* aria-disabled, not disabled, so that it keeps the focus meanwhile. */}
            <Button variant="link" aria-disabled={signingOut} onClick={signOut}>
              Sign out
            </Button>
          </span>
        </div>
        {/* Below the row, so that on a narrow screen it cannot push Sign out out of view. */}
        {failed && (
          <p role="alert" className="mt-1 text-right text-sm text-destructive">
            Could not sign out. Try again.
          </p>
        )}
      </header>
      <Outlet />
    </>
  );
}
