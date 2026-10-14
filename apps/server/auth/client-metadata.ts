// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import type { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

/**
 * Fetches a client's metadata document, or a resource it links, for `cimd()`,
 * keeping Better Auth's transport contract: HTTPS; the host resolved once and
 * every address public; the connection made only to those, TLS verified against
 * the hostname; redirects returned, never followed. It differs from Better
 * Auth's own (`@better-auth/cimd/node`) in two ways:
 *
 * - Every checked address is offered to the connection, not the first: Bun
 *   answers IPv6 first, so on a machine with no IPv6 route Better Auth's refused
 *   every client, Claude's included.
 * - The whole fetch, resolution included, ends after ten seconds or when the
 *   caller aborts: Better Auth leaves a refused response's body open, so a
 *   client's server could otherwise hold sockets indefinitely.
 */
export const fetchPinned: typeof fetchClientMetadataResource = async (input, init) => {
  const asked = new Request(input, init);
  const url = new URL(asked.url);
  if (url.protocol !== "https:") throw new TypeError("a client's metadata is fetched over HTTPS");
  if (asked.method !== "GET" && asked.method !== "HEAD") {
    throw new TypeError("a client's metadata is only read");
  }
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), asked.signal]);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  signal.throwIfAborted();
  const addresses = await untilAborted(lookup(host, { all: true, verbatim: true }), signal);
  if (addresses.length === 0) throw new TypeError("the metadata's host resolved to no address");
  if (!addresses.every(({ address }) => isPublicRoutableHost(address))) {
    throw new TypeError("the metadata's host must resolve to public addresses only");
  }
  const options: ConnectionOptions = {
    agent: false,
    autoSelectFamily: true,
    headers: { ...Object.fromEntries(asked.headers), host: url.host },
    lookup: pinnedLookup(addresses),
    method: asked.method,
    servername: isIP(host) === 0 ? host : undefined,
    signal,
  };
  return new Promise((resolve, reject) => {
    request(url, options, (response) => {
      // A status `Response` refuses (600, say) would otherwise throw here,
      // outside the promise, and take the server down.
      try {
        const status = response.statusCode ?? 500;
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const each of [value ?? []].flat()) headers.append(name, each);
        }
        const empty = asked.method === "HEAD" || [204, 205, 304].includes(status);
        resolve(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream), {
            status,
            statusText: response.statusMessage,
            headers,
          }),
        );
      } catch (error) {
        response.destroy();
        reject(error);
      }
    })
      .once("error", reject)
      .end();
  });
};

/**
 * Fetches a client's metadata document, or a resource it links, for `cimd()`
 * through a Worker's own `fetch`, with the `global_fetch_strictly_public`
 * compatibility flag: Cloudflare then routes it as from the public Internet,
 * observed refusing private destinations (ADR 0045). Without the flag, a URL
 * on the Worker's own zone would reach its origin, past the zone's security
 * settings, so nothing is fetched. Redirects are returned for Better Auth to
 * refuse: Workers reject the `redirect: "error"` it asks for.
 */
export const fetchStrictlyPublic: typeof fetchClientMetadataResource = async (input, init) => {
  if (!fetchIsStrictlyPublic()) {
    throw new TypeError("a client's metadata is fetched only with global_fetch_strictly_public");
  }
  const asked = new Request(input, { ...init, redirect: "manual" });
  const url = new URL(asked.url);
  if (url.protocol !== "https:") throw new TypeError("a client's metadata is fetched over HTTPS");
  if (asked.method !== "GET" && asked.method !== "HEAD") {
    throw new TypeError("a client's metadata is only read");
  }
  // A host written as an address, or `localhost`; a name's addresses are the platform's to refuse.
  if (!isPublicRoutableHost(url.hostname)) {
    throw new TypeError("the metadata's host must be public");
  }
  return fetch(asked);
};

/** Whether this Worker has `global_fetch_strictly_public`, read as workerd's own modules read flags. */
function fetchIsStrictlyPublic(): boolean {
  const { Cloudflare } = globalThis as {
    Cloudflare?: { compatibilityFlags?: Record<string, boolean> };
  };
  return Cloudflare?.compatibilityFlags?.global_fetch_strictly_public === true;
}

/**
 * `autoSelectFamily` tries each address the lookup answers even where the
 * process default is off; Bun's types omit it, which Bun and Node both honor.
 */
type ConnectionOptions = RequestOptions & { autoSelectFamily: boolean };

/** `promise`, or `signal`'s reason once it aborts; the system's lookup takes no signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stopListening = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      stopListening();
      reject(signal.reason);
    };
    // Handled first, so a lookup failing after an abort is not left unhandled.
    promise.then(
      (value) => {
        stopListening();
        resolve(value);
      },
      (error) => {
        stopListening();
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A connection's lookup answering only `addresses`, already checked: every one
 * when the runtime asks for all (`autoSelectFamily` makes it ask, then try each
 * in turn), else the first.
 */
export function pinnedLookup(addresses: LookupAddress[]): RequestOptions["lookup"] {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}
