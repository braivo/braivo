// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { ThemeMenuRadioGroup } from "@braivo/ui";
import { Avatar, AvatarFallback } from "@braivo/ui/components/avatar";
import { Button } from "@braivo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@braivo/ui/components/dropdown-menu";
import { cn } from "@braivo/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import type { Ref } from "react";

import { LanguageRadioGroup } from "./language-menu.tsx";
import { railIdentity, SidebarButton } from "./sidebar-button.tsx";

/** "Avery Reviewer" is "AR", "Olive" is "O": the first letters of its first two words. */
function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

/**
 * The signed-in account, after shadcn's nav-user: its initials open a menu
 * naming it, opening settings, choosing the theme, and signing out. Signing
 * out is the caller's, locked while `signingOut`. `inSidebar`: the name and
 * email beside the initials, which the rail shows alone; else a header's
 * round button. Given `onLanguageFailureChange`, the language too, a failure
 * said by the caller (`LanguageRadioGroup`).
 */
export function AccountMenu({
  ref,
  ...props
}: {
  /** Its trigger, the button showing the initials. */
  ref?: Ref<HTMLButtonElement>;
  user: { name: string; email: string };
  /** The organization shown, whose settings it opens; without one, no Settings item. */
  organizationSlug?: string;
  inSidebar?: boolean;
  onLanguageFailureChange?: (failed: boolean) => void;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { user } = props;
  const { name } = user;
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {props.inSidebar ? (
          <SidebarButton
            ref={ref}
            size="lg"
            tooltip={name}
            aria-label={t`Account: ${name}`}
            // In the rail, round as the avatar it holds, which is a little
            // smaller, so that hovering shows around it.
            className={cn(
              railIdentity,
              "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full",
            )}
          >
            <Avatar className="size-8 group-data-[collapsible=icon]:size-7">
              <AvatarFallback className="font-medium">{initialsOf(name)}</AvatarFallback>
            </Avatar>
            {/* A div: the button truncates its last span, and an identity wraps. */}
            <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <span className="font-medium wrap-anywhere">{name}</span>
              <span className="text-xs wrap-anywhere text-muted-foreground">{user.email}</span>
            </div>
          </SidebarButton>
        ) : (
          // 44px, a touch target's least.
          <Button
            ref={ref}
            variant="ghost"
            size="icon"
            className="size-11 rounded-full"
            aria-label={t`Account: ${name}`}
          >
            <Avatar className="size-9">
              <AvatarFallback className="font-medium">{initialsOf(name)}</AvatarFallback>
            </Avatar>
          </Button>
        )}
      </DropdownMenuTrigger>
      {/* From the sidebar's foot, above it, where the rail leaves room. */}
      <DropdownMenuContent
        side={props.inSidebar ? "top" : "bottom"}
        align={props.inSidebar ? "start" : "end"}
        className="w-64"
      >
        <DropdownMenuLabel className="flex flex-col font-normal">
          <span className="font-medium wrap-anywhere text-foreground">{name}</span>
          <span className="text-xs wrap-anywhere text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {props.organizationSlug && (
          <>
            <DropdownMenuItem asChild>
              <Link
                to="/$organizationSlug/settings/account"
                params={{ organizationSlug: props.organizationSlug }}
              >
                <SettingsIcon />
                <Trans>Settings</Trans>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <Trans>Theme</Trans>
          </DropdownMenuLabel>
          <ThemeMenuRadioGroup />
        </DropdownMenuGroup>
        {props.onLanguageFailureChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                <Trans>Language</Trans>
              </DropdownMenuLabel>
              <LanguageRadioGroup onFailureChange={props.onLanguageFailureChange} />
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={props.signingOut} onSelect={props.onSignOut}>
          <LogOutIcon />
          <Trans>Sign out</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
