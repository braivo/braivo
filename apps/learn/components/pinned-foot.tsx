// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * Its children pinned to the screen's foot while the content above runs
 * longer, so the next step never takes a scroll and sits under the thumb.
 * Opaque and to the page's edges (`main`'s padding), so what scrolls beneath
 * does not show. Its height, as it changes (an alert above a button), is the
 * page's bottom scroll padding, so an element focused or scrolled to above it
 * stops clear of it rather than beneath (WCAG 2.4.11).
 */
export function PinnedFoot({ children }: { children: ReactNode }) {
  const foot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = foot.current!;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.scrollPaddingBottom = `${element.offsetHeight}px`;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.scrollPaddingBottom = "";
    };
  }, []);

  return (
    <div
      ref={foot}
      className="sticky bottom-0 -mx-6 flex flex-col gap-3 bg-background px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      {children}
    </div>
  );
}
