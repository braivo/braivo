// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { ScrollArea } from "@braivo/ui/components/scroll-area";
import { SidebarInset } from "@braivo/ui/components/sidebar";
import type { ReactNode } from "react";

/**
 * The page beside a navigation, as Linear's: from md, a panel raised off the
 * frame, as tall as the window, the page scrolling inside it
 * (`PAGE_SCROLLER`); on a phone, the document scrolls, as the browser's bars
 * and keyboard change its height. It follows a `data-variant="inset"` peer:
 * shadcn's inset `Sidebar`, or settings' own navigation. The column is
 * centred, 768px at most, and starts at one height with a header or without,
 * so a title does not move between pages.
 */
export function PagePanel({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    // Collapsed, as close to the rail as on its other side: shadcn's inset
    // keeps a margin there the rail already leaves.
    <SidebarInset className="min-w-0 md:min-h-0 md:overflow-hidden md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0">
      {/* Without one, the header's room: from md, the sidebar toggle's row
          (8px above a 44px button); on a phone, below settings' row. */}
      {header ?? <div className="h-4 shrink-0 md:h-13" />}
      {/* Radix lays the content out as a table (inline style), which grows
          with its widest line, a long word or a list, past the viewport, which
          clips it: as a block, it takes the viewport's width and wraps. Below
          `md` the page scrolls, not the viewport, whose inline overflow would
          still hold a sticky element inside it, unstuck: visible there. */}
      <ScrollArea
        data-page-scroller=""
        className="md:min-h-0 md:flex-1 max-md:[&>[data-slot=scroll-area-viewport]]:overflow-visible! [&>[data-slot=scroll-area-viewport]>div]:block!"
      >
        <div className="mx-auto w-full max-w-3xl p-6 pt-2">{children}</div>
      </ScrollArea>
    </SidebarInset>
  );
}
