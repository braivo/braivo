// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@braivo/ui/components/breadcrumb";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, Link, Outlet, useMatch, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { AccountMenu } from "#components/account-menu";
import { BraivoLogo } from "#components/braivo-logo";
import { LanguageMenu } from "#components/language-menu";
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

/** The header's latest failure; its count keys the alert, so a repeat is announced too. */
type Failure = { action: "sign-out" | "language"; count: number };

function SignedIn() {
  const { auth, user } = Route.useRouteContext();
  const router = useRouter();
  // Shown on each of its pages, so someone managing several sees which one they act on.
  const organization = useMatch({ from: "/_signed-in/$organizationSlug", shouldThrow: false })
    ?.context.organization;

  const [signingOut, setSigningOut] = useState(false);
  // Shown until its action is tried again or another fails.
  const [failure, setFailure] = useState<Failure>();
  const reportFailure = (action: Failure["action"]) =>
    setFailure((last) => ({ action, count: (last?.count ?? 0) + 1 }));
  const clearFailure = (action: Failure["action"]) =>
    setFailure((last) => (last?.action === action ? undefined : last));

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    clearFailure("sign-out");
    // Better Auth answers a refusal as `error`, and throws when unreachable or out of time.
    const { error } = await auth
      .signOut({ fetchOptions: { signal: withDeadline(undefined, REQUEST_DEADLINE_MS) } })
      .catch(() => ({ error: true }));
    if (error) {
      // Not assumed signed out, so the page stays; clicking again retries.
      reportFailure("sign-out");
      setSigningOut(false);
      return;
    }
    // Runs the check above again, which now sends the owner to sign in.
    await router.invalidate();
  }

  return (
    <>
      {/* Full width; its content 1120px at most. */}
      <header className="border-b bg-card text-card-foreground">
        <div className="mx-auto max-w-280 px-4 sm:px-6">
          <div className="flex min-h-16 items-center justify-between gap-4 py-2">
            {/* The logo leads to every organization: `/` would reopen the last
                one. Growing, so the organization's name wraps in all the room left. */}
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap">
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink asChild>
                    {/* 44px, a touch target's least, as each link here. */}
                    <Link to="/organizations" className="flex min-h-11 min-w-11 items-center">
                      {/* Beside an organization on a phone, the sparkle alone: its
                          name needs the room. */}
                      <BraivoLogo
                        compactOnPhone={!!organization}
                        className="text-2xl text-foreground"
                      />
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {organization && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      <BreadcrumbLink asChild>
                        <Link
                          to="/$organizationSlug"
                          params={{ organizationSlug: organization.slug }}
                          className="flex min-h-11 min-w-11 items-center font-medium wrap-anywhere text-foreground"
                        >
                          {organization.name}
                        </Link>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  </>
                )}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex shrink-0 items-center gap-1">
              <LanguageMenu
                onFailureChange={(failed) =>
                  failed ? reportFailure("language") : clearFailure("language")
                }
              />
              <AccountMenu user={user} signingOut={signingOut} onSignOut={signOut} />
            </div>
          </div>
          {/* Below the row, never in it (docs/apps.md). */}
          {failure && (
            <p
              key={failure.count}
              role="alert"
              className="pb-2 text-right text-sm text-destructive"
            >
              {failure.action === "sign-out" ? (
                <Trans>Could not sign out. Try again.</Trans>
              ) : (
                <Trans>Could not change the language. Try again.</Trans>
              )}
            </p>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl p-6">
        <Outlet />
      </main>
    </>
  );
}
