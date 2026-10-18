// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import { Button } from "@braivo/ui/components/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@braivo/ui/components/sidebar";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatches } from "@tanstack/react-router";
import { BookOpenIcon, LibraryIcon, UsersIcon, XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect } from "react";

import { OrganizationSwitcher } from "./organization-switcher.tsx";
import { SidebarButton, useCloseDrawerOnFollow } from "./sidebar-button.tsx";

/** The organization's home, an administrator's Courses. */
const HOME = "/_signed-in/$organizationSlug/";
/**
 * A course's reports, which keep where they were opened from (`ProgressSearch`).
 * Only their `from` counts: a route without `validateSearch` keeps any search typed.
 */
const REPORTS = new Set<string>([
  "/_signed-in/$organizationSlug/courses/$courseId/progress",
  "/_signed-in/$organizationSlug/courses/$courseId/learners/$learnerId",
]);

/**
 * An organization's sidebar: the organization first, switching to the
 * others; its sections; then `footer`, the account.
 * Collapsed to a rail of icons, each named in a tooltip; on a phone a drawer,
 * closed by navigating, which returns the focus to `toggle`, what opens it,
 * and shows `alert`, a failed action's, as the page behind it is hidden.
 */
export function OrganizationSidebar(props: {
  organization: Organization;
  organizations: Organization[];
  maySetUp: boolean;
  footer: ReactNode;
  alert: ReactNode;
  toggle: RefObject<HTMLElement | null>;
}) {
  const { organization } = props;
  const organizationSlug = organization.slug;
  const { t } = useLingui();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Navigated otherwise (back, forward) while it is open.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  const closeOnFollow = useCloseDrawerOnFollow();
  // The section shown: a source's pages are in Sources; a course's and an
  // objective's in Courses, but a course's in Groups for its reports opened
  // from Groups, and for a teacher, who has only Groups (an objective's page
  // is an administrator's alone).
  const section = useMatches({
    select: (matches) => {
      const under = (path: string) =>
        matches.some(({ routeId }) => routeId.startsWith(`/_signed-in/$organizationSlug/${path}`));
      const fromGroups = matches.some(
        ({ routeId, search }) =>
          REPORTS.has(routeId) && "from" in search && search.from === "groups",
      );
      if (under("sources")) return "sources";
      if (under("groups") || (under("courses") && (fromGroups || !organization.administers))) {
        return "groups";
      }
      if (
        under("courses") ||
        under("objectives") ||
        matches.some(({ routeId }) => routeId === HOME)
      ) {
        return "courses";
      }
    },
  });

  // A teacher's sections are their groups alone (access-39).
  const sections = [
    ...(organization.administers
      ? ([
          { key: "courses", to: "/$organizationSlug", label: t`Courses`, Icon: BookOpenIcon },
          {
            key: "sources",
            to: "/$organizationSlug/sources",
            label: t`Sources`,
            Icon: LibraryIcon,
          },
        ] as const)
      : []),
    { key: "groups", to: "/$organizationSlug/groups", label: t`Groups`, Icon: UsersIcon },
  ] as const;

  return (
    <Sidebar
      variant="inset"
      collapsible="icon"
      mobileTitle={t`Navigation`}
      mobileDescription={t`The organization's pages and your account.`}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-start gap-1">
            <OrganizationSwitcher
              current={organization}
              organizations={props.organizations}
              maySetUp={props.maySetUp}
            />
            {/* The drawer's own way out, besides Escape and the backdrop. */}
            {isMobile && (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label={t`Close navigation`}
                onClick={() => setOpenMobile(false)}
              >
                <XIcon />
              </Button>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          {/* Named for the organization, as settings' is "Settings". */}
          <nav aria-label={organization.name}>
            <SidebarMenu>
              {sections.map(({ key, to, label, Icon }) => (
                <SidebarMenuItem key={key}>
                  {/* Marked through the section's pages; `page` on its own alone,
                    which `exact` keeps the link from claiming for them. */}
                  <SidebarButton
                    asChild
                    isActive={section === key}
                    tooltip={label}
                    className="max-md:h-11"
                  >
                    <Link
                      to={to}
                      params={{ organizationSlug }}
                      activeOptions={{ exact: true, includeSearch: false }}
                      aria-current={section === key ? "true" : undefined}
                      onClick={closeOnFollow}
                    >
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>{props.footer}</SidebarMenu>
        {isMobile && props.alert}
      </SidebarFooter>
      {isMobile && <ReturnFocus to={props.toggle} />}
    </Sidebar>
  );
}

/**
 * Returns the focus to `to` once the drawer holding this is gone, as Radix
 * does for a dialog's trigger, which the drawer lacks; unless something else
 * took it meanwhile. After the drawer's exit animation, so the next frame.
 */
function ReturnFocus({ to }: { to: RefObject<HTMLElement | null> }) {
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) to.current?.focus();
      });
    },
    [to],
  );
  return null;
}
