// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { SidebarMenuButton, useSidebar } from "@braivo/ui/components/sidebar";
import type { ComponentProps, MouseEvent } from "react";

/**
 * shadcn's `SidebarMenuButton`, its `tooltip`, naming it in the rail, left out
 * of a phone's drawer: there, hidden, it still opened on focus and took the
 * first Escape, which is the drawer's to close.
 */
export function SidebarButton({ tooltip, ...props }: ComponentProps<typeof SidebarMenuButton>) {
  const { isMobile } = useSidebar();
  return <SidebarMenuButton tooltip={isMobile ? undefined : tooltip} {...props} />;
}

/**
 * A link's `onClick` in the sidebar: followed, it closes a phone's drawer,
 * even to the page shown, which no navigation reports; not a click opening a
 * new tab or window, which leaves the page as it is.
 */
export function useCloseDrawerOnFollow() {
  const { setOpenMobile } = useSidebar();
  return (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    setOpenMobile(false);
  };
}

/**
 * An identity's `size="lg"` button, the organization's or the account's: as
 * tall as its name wraps to, never truncated (docs/apps.md); in the rail, the
 * square the rail's other buttons are, its text hidden by the caller.
 */
export const railIdentity =
  "h-auto min-h-12 whitespace-normal group-data-[collapsible=icon]:min-h-0";
