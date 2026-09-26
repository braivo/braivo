// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { BetterAuthClientPlugin } from "better-auth/client";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth's React client for an app served alongside Braivo's API.
 *
 * `baseURL` is required rather than left for Better Auth to find: it would
 * otherwise guess from its environment, Vite's `BASE_URL` among the things it
 * tries, which under an app served below the root sends every call to the
 * wrong path.
 */
export function createBrowserAuth<
  const Options extends { baseURL: string; plugins?: BetterAuthClientPlugin[] },
>(options: Options) {
  // Passed through whole: Better Auth infers each plugin's methods from the
  // options' own type, which a re-built object would widen away.
  return createAuthClient(options);
}
