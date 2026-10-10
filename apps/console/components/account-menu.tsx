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
import { Trans, useLingui } from "@lingui/react/macro";
import { LogOutIcon } from "lucide-react";

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
 * naming it, choosing the theme, and signing out. Signing out is the
 * caller's, locked while `signingOut`.
 */
export function AccountMenu(props: {
  user: { name: string; email: string };
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { user } = props;
  const { name } = user;
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px, a touch target's least. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full"
          aria-label={t`Account: ${name}`}
        >
          <Avatar className="size-9">
            <AvatarFallback className="font-medium">{initialsOf(name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col font-normal">
          <span className="font-medium wrap-anywhere text-foreground">{name}</span>
          <span className="text-xs wrap-anywhere text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <Trans>Theme</Trans>
          </DropdownMenuLabel>
          <ThemeMenuRadioGroup />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={props.signingOut} onSelect={props.onSignOut}>
          <LogOutIcon />
          <Trans>Sign out</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
