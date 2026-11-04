// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@braivo/ui/lib/utils";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * Its children at the screen's foot: pinned there while the content above
 * runs longer, pushed there when it is short (in a column at least the
 * screen's height), so the next step never takes a scroll and sits under the
 * thumb in one place.
 * Opaque and to the page's edges (`main`'s padding), so what scrolls beneath
 * does not show. Its height, as it changes (an alert above a button), is the
 * page's bottom scroll padding, so an element focused or scrolled to above it
 * stops clear of it rather than beneath (WCAG 2.4.11). Pinned only while it
 * takes at most half the screen: taller (larger text, a long answer, an
 * alert), it would hide what it speaks of, so it scrolls with the page. Whenever
 * its size or pinning changes with the focus in it (an alert above the focused
 * Continue, pinned or not), a focused control the change moved out of view is
 * brought back, the least scroll that does; with the focus elsewhere, the page
 * stays where the learner is reading.
 */
export function PinnedFoot({
  children,
  className,
}: {
  children: ReactNode;
  /** Its own layout of its children, a column unless given. */
  className?: string;
}) {
  const foot = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = foot.current!;
    const root = document.documentElement;
    const measure = () => {
      const fits = element.offsetHeight <= window.innerHeight / 2;
      setPinned(fits);
      setHeight(element.offsetHeight);
      root.style.scrollPaddingBottom = fits ? `${element.offsetHeight}px` : "";
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      root.style.scrollPaddingBottom = "";
    };
  }, []);

  // After the layout the change made, so the control is measured where it now is.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !foot.current?.contains(focused)) return;
    const { top, bottom } = focused.getBoundingClientRect();
    if (top < 0 || bottom > window.innerHeight) focused.scrollIntoView({ block: "nearest" });
  }, [pinned, height]);

  return (
    <div
      ref={foot}
      // `mt-auto`: in a page at least the screen's height, at its foot even
      // when the content above is short.
      className={cn(
        "-mx-6 mt-auto flex flex-col gap-3 bg-background px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        pinned && "sticky bottom-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
