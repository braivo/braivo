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
import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon } from "lucide-react";
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
              <EmailAddress address={user.email} truncate />
            </div>
            {/* Says it opens a menu, as the organization switcher's does. */}
            <ChevronsUpDownIcon className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
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
          <EmailAddress address={user.email} />
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
              <LanguageRadioGroup inset onFailureChange={props.onLanguageFailureChange} />
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

/**
 * An email address too long for its line, wrapped before its `@` rather than
 * anywhere, which can leave one letter on a line of its own. `truncate`: on
 * one line, the part before the `@` shortened first, so the domain, which
 * says whose account it is, shows whole until nothing else is left to cut.
 */
function EmailAddress({ address, truncate }: { address: string; truncate?: boolean }) {
  const at = address.lastIndexOf("@");
  const [local, domain] = at > 0 ? [address.slice(0, at), address.slice(at)] : [address, ""];
  return truncate ? (
    <span className="flex min-w-0 text-xs text-muted-foreground">
      <span className="truncate">{local}</span>
      {/* Never shrunk while `local` can be; cut only where it alone is too wide. */}
      <span className="max-w-full shrink-0 truncate">{domain}</span>
    </span>
  ) : (
    <span className="text-xs wrap-anywhere text-muted-foreground">
      {local}
      <wbr />
      {domain}
    </span>
  );
}
