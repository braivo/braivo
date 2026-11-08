// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  useMatches,
} from "@tanstack/react-router";

import { Notice } from "#components/notice";
import type { AppContext } from "#lib/context";
import { useHome } from "#lib/home";
import { readHost } from "#lib/host";

export const Route = createRootRouteWithContext<AppContext>()({
  // What this host serves, loaded before sign-in and kept across pages, a
  // course's reloads included: the brand of the organization a domain serves
  // (ADR 0004), or the installation's origin, whose home is `/learn` (ADR 0059).
  // A failure, a timeout included, leaves the app unbranded on a school's
  // home, not down.
  loader: async ({ context }) => {
    const host = await readHost(context.braivo).catch(() => undefined);
    return { organization: host?.organization ?? undefined, installation: !!host?.installation };
  },
  staleTime: Infinity,
  // The title, unless a page names itself (`#lib/title`); `index.html` has none.
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.organization?.name ?? t`Learning` }],
  }),
  component: Root,
  notFoundComponent: NotFound,
});

function NotFound() {
  const { t } = useLingui();
  const home = useHome();
  return (
    <Notice title={t`There is nothing here.`}>
      <Button asChild variant="outline">
        <Link to={home}>
          <Trans>Your courses</Trans>
        </Link>
      </Button>
    </Notice>
  );
}

function Root() {
  // `/login` is a page of its own, `SignInPage`, naming the organization itself.
  const signingIn = useMatches({
    select: (matches) => matches.some(({ routeId }) => routeId === "/login"),
  });

  if (signingIn) {
    return (
      <>
        <HeadContent />
        <Outlet />
      </>
    );
  }
  return (
    <>
      <HeadContent />
      <main className="mx-auto max-w-xl p-6">
        <Outlet />
      </main>
    </>
  );
}
