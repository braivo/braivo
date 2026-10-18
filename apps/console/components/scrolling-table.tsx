// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Table } from "@braivo/ui/components/table";
import { cn } from "@braivo/ui/lib/utils";
import { type ComponentProps, useEffect, useRef, useState } from "react";

/**
 * A table wider than a phone, scrolling inside its own container, whose right
 * edge fades while it hides columns: a touch screen shows no scrollbar, and
 * the last columns would otherwise look absent. Its first column's cells take
 * `pinnedColumn`, so each row stays named as the others scroll.
 */
export function ScrollingTable(props: ComponentProps<typeof Table>) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ before: false, after: false });
  const labelledBy = props["aria-labelledby"];
  // Measured on scroll, and when the container or its table resizes (another
  // language, a search narrowing the rows).
  useEffect(() => {
    const container = wrapper.current!.querySelector<HTMLElement>('[data-slot="table-container"]')!;
    function measure() {
      const before = container.scrollLeft > 1;
      const after = container.scrollLeft + container.clientWidth < container.scrollWidth - 1;
      setHidden((was) => (was.before === before && was.after === after ? was : { before, after }));
      // While it scrolls, a named tab stop, so the keyboard reaches the columns
      // it hides: browsers make a scroller one only when nothing inside is
      // focusable, and a row's link is. Set here: shadcn's container takes no props.
      if (before || after) {
        container.tabIndex = 0;
        container.setAttribute("role", "region");
        if (labelledBy) container.setAttribute("aria-labelledby", labelledBy);
        else container.removeAttribute("aria-labelledby");
      } else {
        for (const name of ["tabindex", "role", "aria-labelledby"]) container.removeAttribute(name);
      }
    }
    measure();
    container.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(container.firstElementChild!);
    return () => {
      container.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [labelledBy]);

  return (
    <div
      ref={wrapper}
      data-scrolled={hidden.before || undefined}
      className={cn(
        "group/scrolling",
        // Not while focused, where it would fade the focus ring too.
        hidden.after &&
          "*:data-[slot=table-container]:not-focus-visible:mask-r-from-[calc(100%-32px)]",
      )}
    >
      <Table {...props} />
    </div>
  );
}

/**
 * For each cell of a `ScrollingTable`'s first column, its header's included:
 * opaque, a hovered row's fill too, so columns scroll under it; edged once
 * they have.
 */
export const pinnedColumn =
  "sticky left-0 z-10 bg-background in-[tr:hover]:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] group-data-scrolled/scrolling:shadow-[inset_-1px_0_var(--border)]";
