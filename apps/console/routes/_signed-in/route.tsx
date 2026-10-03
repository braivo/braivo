// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import { Button } from "@braivo/ui/components/button";
import { createFileRoute, Link, Outlet, useMatch, useRouter } from "@tanstack/react-router";
import { useState } from "react";

/**
 * Everything a content owner sees once signed in. Checked before any child
 * loads, so no page asks Braivo anything on behalf of nobody.
 */
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: ({ context, location }) => requireSession(context.auth, location),
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
    // Better Auth answers a refusal as `error`, and throws only when unreachable.
    const { error } = await auth.signOut().catch(() => ({ error: true }));
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
        <div className="flex items-center justify-between">
          <nav className="flex gap-2 font-semibold">
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
          <span className="flex gap-4">
            {user.name}
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
