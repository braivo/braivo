// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from "@tanstack/react-router";

import { organizationToOpen } from "#lib/last-organization";

/**
 * Where `/` sends a signed-in owner (ADR 0004): the organization last opened
 * here, else the first they administer or teach in, else `/join`.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context, abortController }) => {
    const organizations = await context.braivo.listOrganizations({
      signal: abortController.signal,
    });
    const organization = organizationToOpen(organizations);
    if (!organization) throw redirect({ to: "/join" });
    throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
  },
});
