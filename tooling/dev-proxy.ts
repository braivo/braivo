// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProxyOptions } from "vite-plus";

/**
 * Serves `/api` from a running Braivo server, so an app in development reaches
 * it the way it will in production: from its own origin.
 *
 * Braivo supports one arrangement, where the apps and the API share an origin,
 * and both it and Better Auth refuse a write whose `Origin` is not that one. A
 * development server is a different origin standing in for the same site, so a
 * request same-origin *to it* gets the `Origin` a production reverse proxy
 * would present. Any other is forwarded untouched, and refused as production
 * would refuse it.
 */
export function braivoApi(target: string): Record<string, ProxyOptions> {
  const api = new URL(target).origin;

  return {
    "/api": {
      target: api,
      configure(proxy) {
        proxy.on("proxyReq", (proxied, request) => {
          const origin = request.headers.origin;
          if (origin !== undefined && origin === `http://${request.headers.host}`) {
            proxied.setHeader("origin", api);
          }
        });
      },
    },
  };
}
