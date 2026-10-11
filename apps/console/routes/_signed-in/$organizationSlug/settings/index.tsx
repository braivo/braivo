// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, redirect } from "@tanstack/react-router";

/** Settings open at the account's, the one page every member has. */
export const Route = createFileRoute("/_signed-in/$organizationSlug/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$organizationSlug/settings/account", params, replace: true });
  },
});
