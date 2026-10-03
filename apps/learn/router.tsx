// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { createRouter, type RouterHistory, useRouter } from "@tanstack/react-router";

import { Notice } from "./components/notice.tsx";
import type { AppContext } from "./lib/context.ts";
import { routeTree } from "./routeTree.gen.ts";

/** The learn app's router, as `main.tsx` runs it and its tests render it. */
export function createLearnRouter({
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
    router: ReturnType<typeof createLearnRouter>;
  }
}

/**
 * Generic: what was thrown is implementation text rather than anything a reader
 * can act on. Trying again reruns the failed loads and resets this boundary.
 */
function PageError() {
  const router = useRouter();
  return (
    <Notice title="Something went wrong.">
      <Button onClick={() => router.invalidate()}>Try again</Button>
    </Notice>
  );
}
