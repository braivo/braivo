// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { t } from "@lingui/core/macro";
import { createRootRouteWithContext, HeadContent, Link, Outlet } from "@tanstack/react-router";

import { Notice } from "#components/notice";
import type { AppContext } from "#lib/context";

export const Route = createRootRouteWithContext<AppContext>()({
  // The brand of the organization this domain serves (ADR 0004), loaded before
  // sign-in and once per visit. A failure leaves the app unbranded, not down.
  loader: async ({ context, abortController }) => ({
    organization: await context.braivo
      .hostOrganization({ signal: abortController.signal })
      .catch(() => undefined),
  }),
  staleTime: Infinity,
  // The title, unless a page names itself (`#lib/title`); `index.html` has none.
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.organization?.name ?? t`Learning` }],
  }),
  component: Root,
  notFoundComponent: () => (
    <Notice title="There is nothing here.">
      <Button asChild variant="outline">
        <Link to="/">Your courses</Link>
      </Button>
    </Notice>
  ),
});

function Root() {
  const { organization } = Route.useLoaderData();

  return (
    <>
      <HeadContent />
      <main className="mx-auto max-w-xl p-6">
        {organization && <p className="mb-6 font-semibold">{organization.name}</p>}
        <Outlet />
      </main>
    </>
  );
}
