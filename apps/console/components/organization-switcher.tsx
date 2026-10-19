// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@braivo/ui/components/dropdown-menu";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";

import { railIdentity, SidebarButton, useCloseDrawerOnFollow } from "./sidebar-button.tsx";

/**
 * The organization shown, first in the sidebar: its menu switches between the
 * organizations someone administers, authors, or teaches in (ADR 0004, 0042, 0048), each
 * opening at its home, so no course or source carries over; the list has no
 * page of its own. Last, where offered, setting one up: an `admin` owning none
 * (ADR 0018) never lands on `/join` otherwise.
 */
export function OrganizationSwitcher(props: {
  current: Organization;
  organizations: Organization[];
  maySetUp: boolean;
}) {
  const { name } = props.current;
  const { t } = useLingui();
  const closeOnFollow = useCloseDrawerOnFollow();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The name wraps, never truncated (docs/apps.md); in the rail, the
            initial alone, the name in its tooltip. */}
        <SidebarButton
          size="lg"
          tooltip={name}
          aria-label={t`Organization: ${name}`}
          className={railIdentity}
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary font-medium text-sidebar-primary-foreground"
          >
            {initialOf(name)}
          </span>
          <span className="min-w-0 flex-1 font-medium wrap-anywhere group-data-[collapsible=icon]:hidden">
            {name}
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </SidebarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          <Trans>Organizations</Trans>
        </DropdownMenuLabel>
        {props.organizations.map((organization) => {
          const shown = organization.id === props.current.id;
          return (
            <DropdownMenuItem key={organization.id} asChild>
              <Link
                to="/$organizationSlug"
                params={{ organizationSlug: organization.slug }}
                onClick={closeOnFollow}
              >
                <span className="min-w-0 flex-1 wrap-anywhere">{organization.name}</span>
                {/* Hidden: `aria-current` already says it. */}
                {shown && <CheckIcon aria-hidden="true" />}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {props.maySetUp && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/join" onClick={closeOnFollow}>
                <PlusIcon />
                <Trans>Set up an organization</Trans>
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Example School" is "E": a whole first character, not half of one. */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "").toLocaleUpperCase();
}
