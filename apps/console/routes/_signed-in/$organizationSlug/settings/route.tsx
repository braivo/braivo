// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, MutedText } from "@braivo/ui";
import { cn } from "@braivo/ui/lib/utils";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";

import { appPageToReturnTo } from "#lib/app-page";
import { pageHead } from "#lib/title";

/**
 * Settings, as Linear has them: a page of their own, in place of the console's
 * header. Under the organization, the account's included, so the way back
 * leads to the page in it they were opened from.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings")({
  // A page's own title replaces it; one they do not have keeps it.
  head: (head) => pageHead(head, t`Settings`),
  component: Settings,
  // A page settings do not have, told in their outlet, so their navigation
  // and the way back stay; else the organization's would replace them all.
  notFoundComponent: () => (
    <>
      <Heading>
        <Trans>There is no such setting</Trans>
      </Heading>
      <MutedText className="block wrap-break-word">
        <Trans>Choose one from the list.</Trans>
      </MutedText>
    </>
  ),
});

/** A link in the navigation: 44px high, a touch target's least, marked while its page shows. */
const navLink =
  "flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground";

/** The pages, grouped as Linear's: the account's own, then the organization's. */
const GROUPS = [
  {
    heading: msg`Account`,
    pages: [
      { to: "/$organizationSlug/settings/account", label: msg`Profile` },
      { to: "/$organizationSlug/settings/preferences", label: msg`Preferences` },
    ],
  },
  {
    heading: msg`Organization`,
    pages: [{ to: "/$organizationSlug/settings/members", label: msg`Members` }],
  },
] as const;

function Settings() {
  const { organization } = Route.useRouteContext();
  const { slug: organizationSlug, name: organizationName } = organization;
  const { t, i18n } = useLingui();
  const router = useRouter();
  // The page shown, scrolled into the phone's row if it is off its edge:
  // sideways alone, never the page, as `scrollIntoView` would. A column,
  // from md, never overflows sideways, so nothing moves.
  const pages = useRef<HTMLDivElement>(null);
  const pathname = useLocation({ select: (location) => location.pathname });
  // Opened from the account menu, whose trigger went with the header: focus,
  // lost with it, goes to the page shown in the navigation.
  useLayoutEffect(() => {
    if (document.activeElement !== document.body) return;
    pages.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, []);
  useEffect(() => {
    const row = pages.current;
    const link = row?.querySelector('[aria-current="page"]');
    if (!row || !link) return;
    const { left, right } = row.getBoundingClientRect();
    const shown = link.getBoundingClientRect();
    if (shown.left < left) row.scrollLeft -= left - shown.left;
    else if (shown.right > right) row.scrollLeft += shown.right - right;
  }, [pathname]);
  // Read each render: this layout stays mounted when the organization changes.
  const returnTo = appPageToReturnTo(organizationSlug);

  // Escape leaves, as in Linear, unless it means something where it is
  // pressed: an open dialog or menu closes instead (Radix's listener, on the
  // document while capturing, runs first and prevents the default of the
  // Escape it uses), and a field typed in, or a select, keeps it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      void router.navigate({ href: returnTo });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, returnTo]);

  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <nav
        aria-label={t`Settings`}
        className="border-b bg-sidebar p-3 text-sidebar-foreground md:w-60 md:shrink-0 md:border-r md:border-b-0"
      >
        <a
          href={returnTo}
          className={navLink}
          onClick={(event) => {
            // A new tab or window, asked for, opens as any link's would.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            void router.navigate({ href: returnTo });
          }}
        >
          <ChevronLeftIcon className="size-4 shrink-0" />
          <span className="wrap-anywhere">{t`Back to ${organizationName}`}</span>
        </a>
        {/* On a phone, one row scrolling sideways, the groups' headings for
            screen readers alone, so the page starts near the top; from md, a
            column down the side. */}
        <div
          ref={pages}
          className="-mx-3 mt-2 flex gap-1 overflow-x-auto px-3 md:mx-0 md:mt-0 md:block md:overflow-visible md:px-0"
        >
          {GROUPS.map((group) => (
            <Fragment key={group.heading.id}>
              <h2 className="mt-4 mb-1 px-2 text-xs font-medium text-muted-foreground max-md:sr-only">
                {i18n._(group.heading)}
              </h2>
              <ul className="flex gap-1 md:block">
                {group.pages.map((page) => (
                  <li key={page.to}>
                    <Link
                      to={page.to}
                      params={{ organizationSlug }}
                      className={cn(navLink, "max-md:whitespace-nowrap")}
                    >
                      {i18n._(page.label)}
                    </Link>
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      </nav>
      <main className="w-full max-w-2xl p-6 md:px-10 md:py-12">
        <Outlet />
      </main>
    </div>
  );
}
