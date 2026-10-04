// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@braivo/ui/components/empty";
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";

/**
 * Focuses its element on mount, so focus follows the learner to whatever
 * replaced what they acted on instead of falling to the page. Explicit: React applies
 * `autoFocus` only to form controls. In the commit that shows it, not after:
 * nothing — a screen reader, a test — sees the element without the focus.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return ref;
}

/** What a page says instead of its content, focused as that content would be. */
export function Notice({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const focused = useFocusOnMount<HTMLDivElement>();
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Empty
      ref={focused}
      tabIndex={-1}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      {/* `wrap-anywhere`: centred, so as wide as its longest word otherwise, and a
          description may name an objective holding a link. */}
      <EmptyHeader className="wrap-anywhere">
        <EmptyTitle id={titleId}>{title}</EmptyTitle>
        {description && <EmptyDescription id={descriptionId}>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
