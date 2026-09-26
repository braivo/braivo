// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";

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
  // The one owner of the title; `index.html` has none to compete with it.
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.organization?.name ?? "Learning" }],
  }),
  component: Root,
  notFoundComponent: () => <p>There is nothing here.</p>,
  // Generic: the default renders whatever was thrown, which is implementation
  // text rather than anything a reader can act on.
  errorComponent: () => <p>Something went wrong. Try again.</p>,
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
