// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from "@tanstack/react-router";

import { lastOrganization } from "#lib/last-organization";

/**
 * Where `/` sends a signed-in owner (ADR 0004): the organization last opened
 * here, else the only one they manage, else `/organizations`.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context }) => {
    const organizations = await context.braivo.listOrganizations();

    const last = lastOrganization();
    const organization =
      organizations.find(({ id }) => id === last) ??
      (organizations.length === 1 ? organizations[0] : undefined);
    if (!organization) throw redirect({ to: "/organizations" });
    throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
  },
});
