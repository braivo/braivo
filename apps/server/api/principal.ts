// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A connection's identity on the API's own routes (ADR 0045): `/mcp` builds
// each request to them itself and marks that object in server memory, which no
// network request can claim, whatever headers it carries. A clone or a rebuilt
// request is another object and carries nothing.

import { type BraivoClient, createClient } from "./client.ts";

/** Who a connection acts for: a person, through one OAuth client, as granted. */
export type Principal = {
  userId: string;
  clientId: string;
  scopes: readonly string[];
  /** The organization its grant is for, the only one it reaches. */
  organizationId: string;
};

declare module "hono" {
  interface ContextVariableMap {
    /** Moved from the request by the API's first middleware (`createApi`). */
    connection: Principal | undefined;
  }
}

const principals = new WeakMap<Request, Principal>();

/**
 * A request to `url` as `principal`. Its cookie and `Authorization` are
 * dropped, so no other credential rides along to be read by mistake.
 */
export function createConnectionRequest(
  principal: Principal,
  url: string,
  init?: RequestInit,
): Request {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  const request = new Request(url, { ...init, headers });
  principals.set(request, principal);
  return request;
}

/** The principal `request` was built for by `createConnectionRequest`, or none. */
export function principalOf(request: Request): Principal | undefined {
  return principals.get(request);
}

/**
 * Braivo's API client acting as `principal`, its requests dispatched to `api`
 * in this process against the installation's origin, `baseUrl`.
 */
export function createConnectionClient(options: {
  api: { fetch: (request: Request) => Response | Promise<Response> };
  baseUrl: string;
  principal: Principal;
}): BraivoClient {
  const { api, baseUrl, principal } = options;
  const origin = new URL(baseUrl).origin;
  // The client passes only a path (`createClient`); one naming another origin
  // (`//host/…`) is a bug, not a request to send there.
  const fetch = async (path: string, init?: RequestInit) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error(`Not a path on ${origin}: ${path}`);
    const signal = init?.signal;
    signal?.throwIfAborted();
    const answered = api.fetch(createConnectionRequest(principal, url.href, init));
    if (!signal) return answered;
    // Settled on abort, as `fetch` is, or a caller's deadline would wait out the
    // route; in this process, the route still runs to its end.
    return Promise.race([
      answered,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  };
  return createClient({ fetch: fetch as unknown as typeof globalThis.fetch });
}
