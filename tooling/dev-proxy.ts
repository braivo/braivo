// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Plugin, ProxyOptions } from "vite-plus";

import { DEFAULT_PORTS, readDevPorts } from "./dev-ports.ts";

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
  const site = new URL(env.BRAIVO_URL?.trim() || `http://localhost:${DEFAULT_PORTS.console}`);
  const server = `http://localhost:${readDevPorts(env).server}`;

  return {
    // Remote MCP: the endpoint, and where it says its tokens come from, on
    // `BRAIVO_URL` as clients find them. Clients run outside a browser, so no
    // `Origin` to rewrite. `/mcp` exact, as a prefix would take a slug's page.
    "^/mcp$": { target: server },
    "/.well-known/oauth-protected-resource": { target: server },
    "/api": {
      target: server,
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

/**
 * The learn app's own prefix on the installation's origin, `learn` a reserved
 * slug: My learning there, and the build's files under `/learn/assets/`
 * (ADR 0059). In development, its dev server's modules too.
 */
export const LEARN_PREFIX = "/learn";

/** Paths the learn app's dev server serves as they are: its modules, and what `braivoApi` proxies. */
const AS_IS = /^\/(?:learn\/|api(?:[/?]|$)|mcp(?:\?|$)|\.well-known\/)/;

/**
 * The learn app's dev server keeps its modules under `/learn/` (its `base`),
 * so the console's dev server, standing in for the origin's router, can send
 * it `/learn` and below without taking the console's own. Every page, a learn
 * domain's `/`, `/c/…`, and `/login`, and the origin's `/learn` and `/c/…`, is
 * served from there, the address unchanged, as one build serves both. Opened
 * on the installation's hostname at its own port, it sends the browser to
 * `BRAIVO_URL` instead, where the origin's routes are, `/login` the console's.
 */
export function learnMount(env: { BRAIVO_URL?: string; BRAIVO_LEARN_PORT?: string }): Plugin {
  const site = new URL(env.BRAIVO_URL?.trim() || `http://localhost:${DEFAULT_PORTS.console}`);
  const direct = `${site.hostname}:${readDevPorts(env).learn}`;
  return {
    name: "braivo:learn-mount",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/";
        if (request.headers.host === direct) {
          response.writeHead(302, { location: new URL(url, site.origin).href }).end();
          return;
        }
        if (!AS_IS.test(url)) request.url = `${LEARN_PREFIX}${url}`;
        next();
      });
    },
  };
}

/**
 * The console's dev server standing in for the origin's router: `/learn` and
 * below, and `/c/…`, go to the learn app's dev server, its module reloads'
 * WebSocket too (ADR 0059).
 */
export function learnApp(env: { BRAIVO_LEARN_PORT?: string }): Record<string, ProxyOptions> {
  const learn = { target: `http://localhost:${readDevPorts(env).learn}`, ws: true };
  return { [`^${LEARN_PREFIX}(?:[/?]|$)`]: learn, "^/c(?:[/?]|$)": learn };
}
