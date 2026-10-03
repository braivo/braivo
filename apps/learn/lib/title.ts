// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostOrganization } from "@braivo/server/client";
import { type AnyRouteMatch, rootRouteId } from "@tanstack/react-router";

/**
 * A page's `head`: the page, then the organization the root loaded, so a narrow
 * tab keeps the page. Only on success: a reload ending in not-found keeps the
 * old loader data, which must not name the page then. Otherwise the root's
 * title stands.
 */
export function pageHead(
  { match, matches }: { match: AnyRouteMatch; matches: readonly AnyRouteMatch[] },
  page: string | undefined,
) {
  if (match.status !== "success" || page === undefined) return { meta: [] };
  // A route's `matches` are typed as its own; the root's carry its loader data.
  const root = matches.find(({ routeId }) => routeId === rootRouteId)?.loaderData as
    | { organization?: HostOrganization }
    | undefined;
  const brand = root?.organization?.name;
  return { meta: [{ title: brand ? `${page} · ${brand}` : page }] };
}
