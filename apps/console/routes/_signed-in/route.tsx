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
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useLocation,
  useMatches,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { AccountMenu } from "#components/account-menu";
import { BraivoLogo } from "#components/braivo-logo";
import { LanguageMenu } from "#components/language-menu";
import { OrganizationSwitcher } from "#components/organization-switcher";
import { rememberAppPage } from "#lib/app-page";
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
  // Shown on each of its pages, so someone managing several sees which one they
  // act on, and switches from it.
  const match = useMatch({ from: "/_signed-in/$organizationSlug", shouldThrow: false });
  const { organization, organizations = [] } = match?.context ?? {};
  const maySetUp = useLastSettled(match?.loaderData?.maySetUp, false);
  // Settings are a page of their own, with their own navigation in this frame's place.
  const inSettings = useMatches({
    select: (matches) =>
      matches.some(({ routeId }) => routeId === "/_signed-in/$organizationSlug/settings"),
  });
  // Where leaving settings returns to (`appPageToReturnTo`).
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => rememberAppPage(href), [href]);
  // Left settings, whose navigation took the focus with it: it returns to
  // the account menu, which opened them.
  const accountMenu = useRef<HTMLButtonElement>(null);
  const wasInSettings = useRef(inSettings);
  useLayoutEffect(() => {
    const left = wasInSettings.current && !inSettings;
    wasInSettings.current = inSettings;
    if (left && document.activeElement === document.body) accountMenu.current?.focus();
  }, [inSettings]);

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

  if (inSettings) return <Outlet />;

  return (
    <>
      {/* Full width; its content 1120px at most. */}
      <header className="border-b bg-card text-card-foreground">
        <div className="mx-auto max-w-280 px-4 sm:px-6">
          <div className="flex min-h-16 items-center justify-between gap-4 py-2">
            {/* The logo leads to `/`, the organization last opened. Growing, so
                the organization's name wraps in all the room left. */}
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap">
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink asChild>
                    {/* 44px, a touch target's least, as each link here. */}
                    <Link to="/" className="flex min-h-11 min-w-11 items-center">
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
                      {(organizations.length > 1 || maySetUp) && (
                        <OrganizationSwitcher
                          current={organization}
                          organizations={organizations}
                          maySetUp={maySetUp}
                        />
                      )}
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
              <AccountMenu
                ref={accountMenu}
                user={user}
                organizationSlug={organization?.slug}
                signingOut={signingOut}
                onSignOut={signOut}
              />
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

/**
 * What the latest `promise` settled to, `initial` before any has; kept while
 * the next is read, and when one settles `undefined` (unknown), so the
 * switcher stays mounted, an open menu with it. For the account's `maySetUp`,
 * which no organization changes; signing out unmounts this layout, so no
 * account sees another's. Not `Await`, whose Suspense would remount what it
 * wraps.
 */
function useLastSettled<T>(promise: Promise<T | undefined> | undefined, initial: T): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    // An earlier promise settling late is ignored, not taken over a newer one's.
    let current = true;
    void promise?.then((settled) => current && settled !== undefined && setValue(settled));
    return () => {
      current = false;
    };
  }, [promise]);
  return value;
}
