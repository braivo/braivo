// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@braivo/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@braivo/ui/components/empty";
import { createFileRoute, Link, notFound, Outlet } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

import { OPTIONAL_READ_DEADLINE_MS, REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { rememberOrganization } from "#lib/last-organization";

/**
 * An organization's pages (ADR 0004), and the one place a slug becomes an
 * organization: pages below read `context.organization`, never the slug.
 * Resolved among the organizations someone administers, authors, or teaches
 * in, so any other reads as missing and nothing below runs; `administers`,
 * `authors`, and `teaches` then say which pages they have. The list is kept too, for
 * the sidebar's switcher, with whether it offers setting one up. Read-only, so
 * safe to preload.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug")({
  beforeLoad: async ({ context, params, abortController }) => {
    const organizations = await context.braivo.listOrganizations({
      // Bounded: an action that reads its page again waits on this too.
      signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS),
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
 * organization that names no page, beside the sidebar naming it. Told apart by
 * status: that path leaves this match successful, and its not-found props are
 * empty, not the documented `isNotFound` and `routeId`.
 */
function OrganizationNotFound() {
  return Route.useMatch().status === "notFound" ? (
    <NotFound title="This organization does not exist, or you do not work in it.">
      <Link to="/">Go home</Link>
    </NotFound>
  ) : (
    <NoSuchPage />
  );
}

/** A path in an organization that names no page: a way to its home. */
function NoSuchPage() {
  const { organization } = Route.useRouteContext();
  return (
    <NotFound title="There is nothing here.">
      <Link to="/$organizationSlug" params={{ organizationSlug: organization.slug }}>
        Go to {organization.name}
      </Link>
    </NotFound>
  );
}

/** Not found, with a way out: on a phone the sidebar is a closed drawer, so without one it is a dead end. */
function NotFound(props: { title: string; children: ReactNode }) {
  return (
    // Half shadcn's padding on a phone, as learn's notices, so its words have room.
    <Empty className="max-sm:p-6">
      <EmptyHeader className="wrap-anywhere">
        {/* The page's heading: the title alone is not one. */}
        <EmptyTitle>
          <h1>{props.title}</h1>
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button
          asChild
          variant="outline"
          className="h-auto min-h-9 py-1.5 wrap-anywhere whitespace-normal pointer-coarse:min-h-11 max-md:min-h-11"
        >
          {props.children}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function Organization() {
  const { organization } = Route.useRouteContext();
  // Remembered once shown, not in `beforeLoad`, which preloading also runs.
  useEffect(() => rememberOrganization(organization.id), [organization.id]);
  return <Outlet />;
}
