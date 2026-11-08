// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { getRouteApi } from "@tanstack/react-router";

const root = getRouteApi("__root__");

/**
 * Where a way back leads: `/learn`, My learning, on the installation's origin,
 * whose `/` is the console's (ADR 0059); a school's home, `/`, on its domain.
 */
export function useHome(): "/" | "/learn" {
  return root.useLoaderData({ select: ({ installation }) => (installation ? "/learn" : "/") });
}
