// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createRouter, type RouterHistory, useRouter } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef } from "react";

import type { AppContext } from "./lib/context.ts";
import { routeTree } from "./routeTree.gen.ts";

/** The console's router, as `main.tsx` runs it and its tests render it. */
export function createConsoleRouter({
  context,
  history,
}: {
  context: AppContext;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    context,
    history,
    // A boundary on every route, so a page that fails replaces only itself,
    // not the layouts around it.
    defaultErrorComponent: PageError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createConsoleRouter>;
  }
}

/**
 * Generic: what was thrown is implementation text rather than anything a reader
 * can act on. Trying again reruns the failed loads and resets this boundary.
 */
function PageError() {
  const router = useRouter();
  // Focused, so a failure replacing the page is announced where it happened,
  // and Try again comes next.
  const focused = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => focused.current?.focus(), []);
  const titleId = useId();
  return (
    <Empty ref={focused} tabIndex={-1} role="region" aria-labelledby={titleId}>
      <EmptyHeader>
        <EmptyTitle id={titleId}>Something went wrong.</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={() => router.invalidate()}>Try again</Button>
      </EmptyContent>
    </Empty>
  );
}
