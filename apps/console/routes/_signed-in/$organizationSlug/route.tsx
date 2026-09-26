// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { rememberOrganization } from "#lib/last-organization";

/**
 * An organization's pages (ADR 0004), and the one place a slug becomes an
 * organization: pages below read `context.organization`, never the slug.
 * Resolved among the organizations the owner manages, so one they do not
 * manage reads as missing and nothing below runs. Read-only, so safe to
 * preload.
 */
export const Route = createFileRoute("/_signed-in/$organizationSlug")({
  beforeLoad: async ({ context, params }) => {
    const organizations = await context.braivo.listOrganizations();

    const organization = organizations.find(({ slug }) => slug === params.organizationSlug);
    if (!organization) throw notFound();

    return { organization };
  },
  component: Organization,
  notFoundComponent: () => <p>This organization does not exist, or you do not manage it.</p>,
});

function Organization() {
  const { organization } = Route.useRouteContext();
  // Remembered once shown, not in `beforeLoad`, which preloading also runs.
  useEffect(() => rememberOrganization(organization.id), [organization.id]);
  return <Outlet />;
}
