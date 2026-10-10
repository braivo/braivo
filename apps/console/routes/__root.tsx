// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  useMatch,
  useMatches,
} from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import type { AppContext } from "#lib/context";

export const Route = createRootRouteWithContext<AppContext>()({
  // The title, unless a page names itself: an organization's pages
  // (`#lib/title`), and signing in to its learn domain (`login.tsx`).
  head: () => ({ meta: [{ title: "Braivo Console" }] }),
  component: Root,
  notFoundComponent: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>There is nothing here.</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/organizations">Organizations</Link>
        </Button>
      </EmptyContent>
    </Empty>
  ),
});

function Root() {
  // A learn domain's sign-in, loading and failed alike, is marked so that it
  // wears none of Braivo's colours (`styles.css`, ADR 0018): on `<html>`, so
  // dialogs and popovers outside `<main>` follow. `index.html` marks it before
  // the app starts; from here the route decides, so leaving it unmarks it.
  const learnDomain = useMatch({
    from: "/login",
    shouldThrow: false,
    select: (match) => match.search.handoff !== undefined,
  });
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-learn-domain", learnDomain === true);
  }, [learnDomain]);
  // `/login` (`ConsoleSignInPage`) and the signed-in pages (under their header)
  // render their own `<main>`; loading or failed, they get this column.
  const framed = useMatches({
    select: (matches) =>
      matches.some(
        (match) =>
          (match.routeId === "/login" || match.routeId === "/_signed-in") &&
          match.status === "success",
      ),
  });
  return (
    <>
      <HeadContent />
      {framed ? (
        <Outlet />
      ) : (
        <main className="mx-auto max-w-3xl p-6">
          <Outlet />
        </main>
      )}
    </>
  );
}
