// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { AppContext } from "#lib/context";

export const Route = createRootRouteWithContext<AppContext>()({
  component: () => (
    <main className="mx-auto max-w-xl p-6">
      <Outlet />
    </main>
  ),
  notFoundComponent: () => <p>There is nothing here.</p>,
  // Generic: the default renders whatever was thrown, which is implementation
  // text rather than anything a reader can act on.
  errorComponent: () => <p>Something went wrong. Try again.</p>,
});
