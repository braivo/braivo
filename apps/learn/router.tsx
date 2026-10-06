// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { LocalizationProvider } from "@braivo/i18n";
import { Button } from "@braivo/ui/components/button";
import { Spinner } from "@braivo/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
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
    // In place of a page still loading after `pendingMs` (a second), so a slow
    // connection shows a page on its way rather than a blank or unchanged one.
    // Not while a layout already shown reruns a slow `beforeLoad` (the session
    // check, say): the old page stays meanwhile.
    defaultPendingComponent: PagePending,
    // Marked copy's provider, here so that tests rendering the router get it too.
    Wrap: LocalizationProvider,
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
  const { t } = useLingui();
  return (
    <Notice title={t`Something went wrong.`}>
      <Button onClick={() => router.invalidate()}>
        <Trans>Try again</Trans>
      </Button>
    </Notice>
  );
}

function PagePending() {
  const { t } = useLingui();
  return (
    <Spinner aria-label={t`Loading`} className="mx-auto my-12 block size-6 text-muted-foreground" />
  );
}
