// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { requireSession } from "@braivo/auth-client";
import { Button } from "@braivo/ui/components/button";
import { SidebarMenuItem, SidebarProvider, useSidebar } from "@braivo/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@braivo/ui/components/tooltip";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useLocation,
  useMatches,
  useRouter,
} from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AccountMenu } from "#components/account-menu";
import { BraivoLogo } from "#components/braivo-logo";
import { LanguageMenu } from "#components/language-menu";
import { OrganizationSidebar } from "#components/organization-sidebar";
import { PagePanel } from "#components/page-panel";
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

/** The latest failure of the header's or sidebar's menus; its count keys the alert, so a repeat is announced too. */
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
  // the account menu, which opened them, or, in a phone's closed drawer, to
  // what opens it.
  const accountMenu = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const wasInSettings = useRef(inSettings);
  useLayoutEffect(() => {
    const left = wasInSettings.current && !inSettings;
    wasInSettings.current = inSettings;
    if (!left || document.activeElement !== document.body) return;
    // On a phone, before the drawer replaces it, the menu is in a hidden
    // sidebar, so focusing it fails.
    accountMenu.current?.focus();
    if (document.activeElement === document.body) toggle.current?.focus();
  }, [inSettings]);
  // Expanded or collapsed, here, so that it holds across an organization's
  // pages, other organizations', and a visit to settings, which replace the
  // sidebar. Not kept across reloads.
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  const reportLanguage = (failed: boolean) =>
    failed ? reportFailure("language") : clearFailure("language");
  const accountMenuOf = (inSidebar: boolean) => (
    <AccountMenu
      ref={accountMenu}
      inSidebar={inSidebar}
      onLanguageFailureChange={inSidebar ? reportLanguage : undefined}
      user={user}
      organizationSlug={organization?.slug}
      signingOut={signingOut}
      onSignOut={signOut}
    />
  );
  // Below the row, never in it (docs/apps.md).
  const failed = failure && (
    <p key={failure.count} role="alert" className="pb-2 text-right text-sm text-destructive">
      {failure.action === "sign-out" ? (
        <Trans>Could not sign out. Try again.</Trans>
      ) : (
        <Trans>Could not change the language. Try again.</Trans>
      )}
    </p>
  );

  // An organization's pages, in its sidebar; anywhere else (`/join`, a device
  // code, an organization not found), a header.
  if (organization) {
    return (
      <TooltipProvider>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="md:h-svh">
          <OrganizationSidebar
            organization={organization}
            organizations={organizations}
            maySetUp={maySetUp}
            alert={failed}
            toggle={toggle}
            footer={<SidebarMenuItem>{accountMenuOf(true)}</SidebarMenuItem>}
          />
          <PagePanel
            header={
              <header className="shrink-0 px-2 pt-2 sm:px-4">
                <div className="flex items-center gap-2">
                  <SidebarToggle ref={toggle} />
                  <ShownOrganization name={organization.name} />
                </div>
                {failed}
              </header>
            }
          >
            <Outlet />
          </PagePanel>
        </SidebarProvider>
      </TooltipProvider>
    );
  }

  return (
    <>
      {/* Full width; its content 1120px at most. */}
      <header className="border-b bg-card text-card-foreground">
        <div className="mx-auto max-w-280 px-4 sm:px-6">
          <div className="flex min-h-16 items-center justify-between gap-4 py-2">
            {/* The logo leads to `/`, the organization last opened. 44px, a
                touch target's least, as each control here. */}
            <Link to="/" className="flex min-h-11 min-w-11 items-center">
              <BraivoLogo className="text-2xl text-foreground" />
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              <LanguageMenu onFailureChange={reportLanguage} />
              {accountMenuOf(false)}
            </div>
          </div>
          {failed}
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl p-6">
        <Outlet />
      </main>
    </>
  );
}

/**
 * Collapses the sidebar to its rail and expands it again; on a phone, opens
 * its drawer. Named for what it does next, in place of shadcn's
 * `SidebarTrigger`, whose name is English alone.
 */
function SidebarToggle({ ref }: { ref?: Ref<HTMLButtonElement> }) {
  const { t } = useLingui();
  const { isMobile, open, toggleSidebar } = useSidebar();
  const label = isMobile ? t`Open navigation` : open ? t`Collapse sidebar` : t`Expand sidebar`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 44px, a touch target's least. The provider's shortcut toggles it too. */}
        <Button
          ref={ref}
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={label}
          aria-keyshortcuts={isMobile ? undefined : "Control+B Meta+B"}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The organization's name where the sidebar does not show it: on a phone,
 * the drawer closed, and beside the rail. So whoever manages several sees
 * which one they act on. Hidden beside the expanded sidebar by CSS, `md:`,
 * not by `isMobile`, which is known only after the first render.
 */
function ShownOrganization({ name }: { name: string }) {
  const { open } = useSidebar();
  return (
    <span className={cn("min-w-0 font-medium wrap-anywhere", open && "md:hidden")}>{name}</span>
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
