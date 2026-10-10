// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProxyOptions } from "vite-plus";

/**
 * Serves `/api` from the Braivo server running on `PORT`, so an app in
 * development reaches it the way it will in production: from its own origin.
 *
 * `BRAIVO_URL` is the site's public origin, which the server builds links from
 * (Google's callback, a learn domain's handoff), so locally it is the console's
 * dev server, never the server's own port.
 *
 * Braivo and Better Auth refuse a write whose `Origin` they do not trust. A
 * page on this dev server writes with the `Origin` the deployed site would
 * send: `BRAIVO_URL`'s on the installation's host, where both apps run
 * locally (access-19), and `https://<hostname>` on an organization's domain,
 * `<slug>.localhost` (access-28). Any other `Origin` is forwarded untouched,
 * for the server to judge.
 */
export function braivoApi(env: {
  BRAIVO_URL?: string;
  PORT?: string;
}): Record<string, ProxyOptions> {
  const site = new URL(env.BRAIVO_URL ?? "http://localhost:5174");

  return {
    "/api": {
      target: `http://localhost:${env.PORT || 3000}`,
      configure(proxy) {
        proxy.on("proxyReq", (proxied, request) => {
          const origin = request.headers.origin;
          const { host } = request.headers;
          if (origin === undefined || host === undefined || origin !== `http://${host}`) return;
          const { hostname } = new URL(origin);
          proxied.setHeader(
            "origin",
            hostname === site.hostname ? site.origin : `https://${hostname}`,
          );
        });
      },
    },
  };
}
