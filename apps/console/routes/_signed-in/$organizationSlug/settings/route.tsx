// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import { msg, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";

import { NoSuchSetting } from "#components/no-such-setting";
import { appPageToReturnTo } from "#lib/app-page";
import { pageHead } from "#lib/title";

/**
 * Settings, as Linear has them: a page of their own, in place of the console's
 * sidebar. Under the organization, the account's included, so the way back
 * leads to the page in it they were opened from.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings")({
  // A page's own title replaces it; one they do not have keeps it.
  head: (head) => pageHead(head, t`Settings`),
  component: Settings,
  // A page settings do not have, told in their outlet, so their navigation
  // and the way back stay; else the organization's would replace them all.
  notFoundComponent: NoSuchSetting,
});

/**
 * A link in the navigation, as the sidebar's: 32px high, 44px on a phone, a
 * touch target's least; marked while its page shows.
 */
const navLink =
  "flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm ring-sidebar-ring outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground md:min-h-8";

/**
 * The pages, grouped as Linear's: the account's own, then the organization's,
 * for whoever administers it alone (access-39).
 */
const SECTIONS = [
  {
    heading: msg`Account`,
    administratorsOnly: false,
    pages: [
      { to: "/$organizationSlug/settings/account", label: msg`Profile` },
      { to: "/$organizationSlug/settings/preferences", label: msg`Preferences` },
      { to: "/$organizationSlug/settings/connections", label: msg`Connected apps` },
    ],
  },
  {
    heading: msg`Organization`,
    administratorsOnly: true,
    pages: [
      { to: "/$organizationSlug/settings/general", label: msg`General` },
      { to: "/$organizationSlug/settings/members", label: msg`Members` },
      { to: "/$organizationSlug/settings/groups", label: msg`Groups` },
      { to: "/$organizationSlug/settings/domains", label: msg`Domains` },
    ],
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
  // Opened from the account menu, whose trigger went with the sidebar: focus,
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
            screen readers alone, so the page starts near the top, its padding
            room for the focus ring it would clip; from md, a column down the
            side. */}
        <div
          ref={pages}
          className="-mx-3 mt-1 flex gap-1 overflow-x-auto px-3 py-1 md:mx-0 md:mt-0 md:block md:overflow-visible md:p-0"
        >
          {SECTIONS.filter(
            ({ administratorsOnly }) => organization.administers || !administratorsOnly,
          ).map((group) => (
            <Fragment key={group.heading.id}>
              <h2 className="mt-4 mb-1 px-3 text-xs font-medium text-muted-foreground max-md:sr-only">
                {i18n._(group.heading)}
              </h2>
              <ul className="flex gap-1 md:flex-col md:gap-0.5">
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
