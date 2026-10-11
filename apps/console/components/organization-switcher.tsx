// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import { Button } from "@braivo/ui/components/button";
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

/**
 * Switches between the organizations someone manages (ADR 0004), each
 * opening at its home; the list has no page of its own. Shown with two or
 * more, or to offer its last item, setting one up: an `admin` owning none
 * (ADR 0018) never lands on `/join` otherwise.
 */
export function OrganizationSwitcher(props: {
  current: Organization;
  organizations: Organization[];
  maySetUp: boolean;
}) {
  const { current } = props;
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px, a touch target's least, as each control in the header. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-muted-foreground"
          // Not "Switch": beside one organization, it may only offer setting one up.
          aria-label={t`Organizations`}
        >
          <ChevronsUpDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          <Trans>Organizations</Trans>
        </DropdownMenuLabel>
        {props.organizations.map((organization) => {
          const shown = organization.id === current.id;
          return (
            <DropdownMenuItem key={organization.id} asChild>
              <Link to="/$organizationSlug" params={{ organizationSlug: organization.slug }}>
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
              <Link to="/join">
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
