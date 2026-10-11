// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { OPTIONAL_READ_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { rememberOrganization } from "#lib/last-organization";

/**
 * An organization's pages (ADR 0004), and the one place a slug becomes an
 * organization: pages below read `context.organization`, never the slug.
 * Resolved among the organizations the owner manages, so one they do not
 * manage reads as missing and nothing below runs. The list is kept too, for
 * the header's switcher, with whether it offers setting one up. Read-only, so
 * safe to preload.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug")({
  beforeLoad: async ({ context, params, abortController }) => {
    const organizations = await context.braivo.listOrganizations({
      signal: abortController.signal,
    });

    const organization = organizations.find(({ slug }) => slug === params.organizationSlug);
    if (!organization) throw notFound();

    return { organization, organizations };
  },
  // Optional, so not awaited: the page shows at once, the switcher's setup
  // item once known. Read again on each navigation, as the list is; one
  // unanswered or failed is `undefined`, unknown, never taken for a refusal.
  loader: ({ context, abortController }) => ({
    maySetUp: context.braivo
      .organizationSetup({
        signal: withDeadline(abortController.signal, OPTIONAL_READ_DEADLINE_MS),
      })
      .then(
        (setup) => setup?.maySetUp ?? false,
        () => undefined,
      ),
  }),
  // Stale loaders reload only when their route is entered, not between its pages.
  shouldReload: true,
  component: Organization,
  notFoundComponent: OrganizationNotFound,
});

/**
 * The slug, when `beforeLoad` found no organization. Otherwise a path below an
 * organization that names no page, under the header naming it. Told apart by
 * status: that path leaves this match successful, and its not-found props are
 * empty, not the documented `isNotFound` and `routeId`.
 */
function OrganizationNotFound() {
  return Route.useMatch().status === "notFound" ? (
    <p>This organization does not exist, or you do not manage it.</p>
  ) : (
    <p>There is nothing here.</p>
  );
}

function Organization() {
  const { organization } = Route.useRouteContext();
  // Remembered once shown, not in `beforeLoad`, which preloading also runs.
  useEffect(() => rememberOrganization(organization.id), [organization.id]);
  return <Outlet />;
}
