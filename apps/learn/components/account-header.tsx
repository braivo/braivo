// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { READ_DEADLINE_MS, withDeadline } from "#lib/deadline";

const root = getRouteApi("__root__");
const signedIn = getRouteApi("/_signed-in");

/**
 * The organization, the learner, and Sign out: above the course list only.
 * Practice is a focused screen of its own, closed back to that list.
 */
export function AccountHeader() {
  const { organization } = root.useLoaderData();
  const { braivo, user } = signedIn.useRouteContext();
  const router = useRouter();

  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFailed(false);
    try {
      // This domain's session alone (ADR 0018). On a shared device, never
      // pending for good with the account still shown.
      await braivo.signOut({ signal: withDeadline(undefined, READ_DEADLINE_MS) });
    } catch {
      // Not assumed signed out, so the page stays; clicking again retries.
      setFailed(true);
      setSigningOut(false);
      return;
    }
    // Runs the guard again, which now sends the learner to sign in.
    await router.invalidate();
  }

  return (
    <header className="mb-6">
      {organization && <p className="mb-6 font-semibold">{organization.name}</p>}
      <div className="flex items-center justify-between">
        <span>{user.name}</span>
        {/* aria-disabled, not disabled, so that it keeps the focus meanwhile;
            its text, not its padding, at the page's edge. */}
        <Button variant="link" className="-me-3" aria-disabled={signingOut} onClick={signOut}>
          <Trans>Sign out</Trans>
        </Button>
      </div>
      {/* Below the row, so that on a narrow screen it cannot push Sign out out of view. */}
      {failed && (
        <p role="alert" className="mt-1 text-right text-sm text-destructive">
          <Trans>Could not sign out. Try again.</Trans>
        </p>
      )}
    </header>
  );
}
