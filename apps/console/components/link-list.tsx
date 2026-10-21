// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * Rows that each lead to a page, bordered as one list; each `<li>` holds a
 * `linkRow` link. The end links are rounded rather than the list clipped, which
 * would hide a row's focus where forced colours draw it outside.
 */
export function LinkList({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "divide-y rounded-xl border [&>li:first-child>a]:rounded-t-xl [&>li:last-child>a]:rounded-b-xl",
        className,
      )}
      {...props}
    />
  );
}

/** A `LinkList` row's link, the whole row: a chevron or a short label at its end. */
export const linkRow =
  "flex min-h-11 items-center justify-between gap-2 px-3 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-9";
