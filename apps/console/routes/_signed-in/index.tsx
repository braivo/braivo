// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { lastUsed } from "@braivo/auth-client";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { REQUEST_DEADLINE_MS, withDeadline } from "#lib/deadline";
import { organizationToOpen } from "#lib/last-organization";

/**
 * Where a bare `/` resumes, in the browser once the page has loaded
 * (ADR 0059, access-59): the area this account last used here, My learning or
 * an organization's console while it is still theirs; else, for someone with
 * staff access to a school, its console; else My learning. Personal
 * organizations are no school. Only `/`: every other address reaches its own
 * page. My learning is the learn app's, so loaded in `/`'s place, never routed.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context, abortController }) => {
    const toLearning = () => {
      context.visit("/learn", { replace: true });
      return { leaving: true };
    };
    if (lastUsed(context.user.id)?.area === "learning") return toLearning();
    // Unanswered in time, as unanswered at all, the page fails and offers
    // Try again, rather than leave someone just signed in waiting.
    const organization = organizationToOpen(
      await context.braivo.listOrganizations({
        signal: withDeadline(abortController.signal, REQUEST_DEADLINE_MS),
      }),
      context.user.id,
    );
    if (!organization) return toLearning();
    throw redirect({ to: "/$organizationSlug", params: { organizationSlug: organization.slug } });
  },
  // Leaving for My learning: nothing to show meanwhile.
  component: () => null,
});
