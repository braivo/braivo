// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import { Button } from "@braivo/ui/components/button";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";

/**
 * Everything a learner sees once signed in. Checked before any child loads, so
 * no page asks Braivo anything on behalf of nobody.
 */
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: ({ context, location }) => requireSession(context.auth, location),
  component: SignedIn,
});

function SignedIn() {
  const { auth, user } = Route.useRouteContext();
  const router = useRouter();

  async function signOut() {
    await auth.signOut();
    // Runs the check above again, which now sends the learner to sign in.
    await router.invalidate();
  }

  return (
    <>
      <header className="mb-6 flex items-center justify-between">
        <span>{user.name}</span>
        <Button variant="link" onClick={signOut}>
          Sign out
        </Button>
      </header>
      <Outlet />
    </>
  );
}
