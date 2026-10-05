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
} from "@tanstack/react-router";

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
  // wears none of Braivo's colours (`styles.css`, ADR 0018).
  const learnDomain = useMatch({
    from: "/login",
    shouldThrow: false,
    select: (match) => match.search.handoff !== undefined,
  });
  return (
    <>
      <HeadContent />
      <main data-learn-domain={learnDomain ? "" : undefined} className="mx-auto max-w-3xl p-6">
        <Outlet />
      </main>
    </>
  );
}
