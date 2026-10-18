// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A native disclosure: `summary` toggles `children`. The summary is a touch
 * target, 44px tall on a phone or a touch screen, else 24px, and turns a
 * chevron, one of the console's icons, not the browser's triangle. `label`
 * names the toggle where its text alone would not say what it opens.
 */
export function Disclosure(props: {
  summary: ReactNode;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("group/disclosure", props.className)}>
      <summary
        aria-label={props.label}
        // The target's height is its `::after`'s, centred on the line: as the
        // summary's own, it would leave a gap between the line and what it opens.
        className="relative flex cursor-pointer list-none items-start gap-1 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 md:after:h-6 md:pointer-coarse:after:h-11 [&::-webkit-details-marker]:hidden"
      >
        {/* Centred on the text's first line, should it wrap. */}
        <span className="flex h-lh shrink-0 items-center">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 transition-transform group-open/disclosure:rotate-90"
          />
        </span>
        {props.summary}
      </summary>
      {props.children}
    </details>
  );
}
