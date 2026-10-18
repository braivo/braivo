// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import { msg, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, Outlet, useLocation, useRouter } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  CircleUserRoundIcon,
  ContactRoundIcon,
  GlobeIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import { NoSuchSetting } from "#components/no-such-setting";
import { PagePanel } from "#components/page-panel";
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
  "flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium ring-sidebar-ring outline-hidden text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-accent-foreground focus-visible:ring-3 data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground md:min-h-8";

/** Each fade's width on the phone's row, in px; its mask classes repeat it. */
const FADE_WIDTH = 40;

/** The link to the page shown. */
function currentLink(row: Element) {
  return row.querySelector<HTMLElement>('[aria-current="page"]');
}

/**
 * Scrolls a link into the phone's row if it, or its 3px focus ring, is off
 * its edge or under its fade: sideways alone, never the page, as
 * `scrollIntoView` would. A column, from md, never overflows sideways, so
 * nothing moves; a row not laid out has no room to move it into.
 */
function reveal(row: Element, link: Element | null) {
  const edges = row.getBoundingClientRect();
  const [left, right] = [edges.left + FADE_WIDTH + 4, edges.right - FADE_WIDTH - 4];
  if (!link || left >= right) return;
  const shown = link.getBoundingClientRect();
  if (shown.left < left) row.scrollLeft -= left - shown.left;
  else if (shown.right > right) row.scrollLeft += shown.right - right;
}

/**
 * The pages, grouped as Linear's: the account's own, then the organization's,
 * for whoever administers it alone (access-39). Each with its icon, as
 * Linear's; Groups wears the sidebar's.
 */
const SECTIONS = [
  {
    heading: msg`Account`,
    administratorsOnly: false,
    pages: [
      { to: "/$organizationSlug/settings/account", label: msg`Profile`, Icon: CircleUserRoundIcon },
      {
        to: "/$organizationSlug/settings/preferences",
        label: msg`Preferences`,
        Icon: SlidersHorizontalIcon,
      },
      {
        to: "/$organizationSlug/settings/connections",
        label: msg`Connected apps`,
        Icon: PlugIcon,
      },
    ],
  },
  {
    heading: msg`Organization`,
    administratorsOnly: true,
    pages: [
      { to: "/$organizationSlug/settings/general", label: msg`General`, Icon: SettingsIcon },
      { to: "/$organizationSlug/settings/members", label: msg`Members`, Icon: ContactRoundIcon },
      { to: "/$organizationSlug/settings/groups", label: msg`Groups`, Icon: UsersIcon },
      { to: "/$organizationSlug/settings/domains", label: msg`Domains`, Icon: GlobeIcon },
    ],
  },
] as const;

function Settings() {
  const { organization } = Route.useRouteContext();
  const { slug: organizationSlug, name: organizationName } = organization;
  const { t, i18n } = useLingui();
  const router = useRouter();
  const pages = useRef<HTMLDivElement>(null);
  const pathname = useLocation({ select: (location) => location.pathname });
  // Opened from the account menu, whose trigger went with the sidebar: focus,
  // lost with it, goes to the page shown in the navigation.
  useLayoutEffect(() => {
    if (document.activeElement !== document.body) return;
    currentLink(pages.current!)?.focus();
  }, []);
  // The page shown, revealed in the phone's row.
  useEffect(() => {
    const row = pages.current!;
    reveal(row, currentLink(row));
  }, [pathname]);
  // The row's edges that hide pages, faded so a phone shows there are more.
  // Measured on scroll, and when the row or its pages resize (another
  // language or organization). A resize reveals the page shown again: a phone
  // turned upright makes the column a row, scrolled to its start.
  const [hiddenPages, setHiddenPages] = useState({ before: false, after: false });
  useEffect(() => {
    const row = pages.current!;
    function measure() {
      const before = row.scrollLeft > 0;
      const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setHiddenPages((was) =>
        was.before === before && was.after === after ? was : { before, after },
      );
    }
    measure();
    row.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(() => {
      reveal(row, currentLink(row));
      measure();
    });
    observer.observe(row);
    for (const list of row.querySelectorAll("ul")) observer.observe(list);
    return () => {
      row.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [organization.administers]);
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
    // The console's frame (`PagePanel`), the navigation as wide as its sidebar
    // (shadcn's 16rem) in its place; on a phone, a row above the page. No
    // `SidebarProvider`: nothing here collapses.
    <div className="flex min-h-svh w-full bg-sidebar max-md:flex-col md:h-svh">
      <nav
        aria-label={t`Settings`}
        data-variant="inset"
        className="peer p-3 text-sidebar-foreground max-md:border-b md:w-64 md:shrink-0"
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
          {/* One line, as the sidebar's rows; a name cut short shows whole on hover. */}
          <span className="truncate" title={organizationName}>
            {t`Back to ${organizationName}`}
          </span>
        </a>
        {/* On a phone, one row scrolling sideways, the groups' headings for
            screen readers alone, so the page starts near the top, its padding
            room for the focus ring it would clip; from md, a column down the
            side. */}
        <div
          ref={pages}
          // Reveals a link tabbed to, which a browser scrolls only to the row's
          // edge; not one pressed: moved from under the pointer, it would lose
          // its click.
          onFocus={(event) => {
            if (event.target.matches(":focus-visible")) reveal(event.currentTarget, event.target);
          }}
          className={cn(
            "-mx-3 mt-1 flex gap-1 overflow-x-auto px-3 py-1 md:mx-0 md:mt-0 md:block md:overflow-visible md:p-0",
            hiddenPages.before && "max-md:mask-l-from-[calc(100%-40px)]",
            hiddenPages.after && "max-md:mask-r-from-[calc(100%-40px)]",
          )}
        >
          {SECTIONS.filter(
            ({ administratorsOnly }) => organization.administers || !administratorsOnly,
          ).map((group) => (
            <Fragment key={group.heading.id}>
              <h2 className="mt-4 mb-1 px-3 text-xs font-medium text-muted-foreground max-md:sr-only">
                {i18n._(group.heading)}
              </h2>
              <ul className="flex gap-1 md:flex-col md:gap-0.5">
                {group.pages.map(({ Icon, ...page }) => (
                  <li key={page.to}>
                    <Link
                      to={page.to}
                      params={{ organizationSlug }}
                      className={cn(navLink, "max-md:whitespace-nowrap")}
                    >
                      <Icon className="size-4 shrink-0" />
                      {i18n._(page.label)}
                    </Link>
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      </nav>
      <PagePanel>
        <Outlet />
      </PagePanel>
    </div>
  );
}
