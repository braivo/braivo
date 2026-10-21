// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import type { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";

/** How `cimd()` fetches a client's metadata document and the `jwks_uri` it names. */
export type ClientMetadataFetch = typeof fetchClientMetadataResource;

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
export const fetchPinned: ClientMetadataFetch = async (input, init) => {
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
export const fetchStrictlyPublic: ClientMetadataFetch = async (input, init) => {
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

/** Where Gemini's client ID metadata documents are, and the keys they name. */
const GOOGLE_DOCUMENT_ORIGIN = "https://accountlinking.google.com";
const GOOGLE_JWKS_URI =
  "https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json";
/** Where Better Auth is told Google's documents keep their keys. */
const GOOGLE_JWKS_ALIAS = `${GOOGLE_DOCUMENT_ORIGIN}/.well-known/braivo-cross-origin-jwks`;

/** Better Auth's limits on what comes through here: a client's document, and its keys. */
const MAX_DOCUMENT_BYTES = 5 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;

/**
 * Wraps `fetch` so Gemini signs in with its keys on another origin, trusting
 * that origin for nothing else (ADR 0045, keys on another origin). Better
 * Auth is shown their `jwks_uri` as an alias on the document's origin, which
 * this fetch, the only one it reads a client's keys through, answers from the
 * real URL; it then caches and refetches them as any client's.
 *
 * Until better-auth/better-auth#11916 ships. A client's record keeps the alias
 * until its document is read again, which a restart's empty cache makes its
 * next use do, so the deploy removing this leaves no alias in use.
 */
export function aliasGoogleJwks(fetch: ClientMetadataFetch): ClientMetadataFetch {
  return async (input, init) => {
    // Not `new Request(input, init)`: Workers refuse the `redirect: "error"` Better Auth asks for.
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== GOOGLE_DOCUMENT_ORIGIN) return fetch(input, init);
    if (url.href === GOOGLE_JWKS_ALIAS) {
      return fetch(
        input instanceof Request ? new Request(GOOGLE_JWKS_URI, input) : GOOGLE_JWKS_URI,
        init,
      );
    }
    const response = await fetch(input, init);
    // A redirect is returned as it came, for Better Auth to refuse.
    if (response.status !== 200 || response.redirected || response.body === null) return response;
    const bytes = await readUpTo(response.body, MAX_JWKS_BYTES);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const { status, statusText } = response;
    // Measured before rewriting, which may shrink a document over Better Auth's limit under it.
    const body = bytes.byteLength > MAX_DOCUMENT_BYTES ? bytes : rewriteJwksUri(bytes);
    return new Response(body, { status, statusText, headers });
  };
}

/** `document` naming Google's keys, rewritten to name their alias; any other, as it is. */
function rewriteJwksUri(document: Uint8Array): Uint8Array | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(document));
  } catch {
    return document;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return document;
  if (!("jwks_uri" in parsed) || parsed.jwks_uri !== GOOGLE_JWKS_URI) return document;
  return JSON.stringify({ ...parsed, jwks_uri: GOOGLE_JWKS_ALIAS });
}

/** `body`'s bytes, refused once more than `limit`. */
async function readUpTo(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(limit);
  let length = 0;
  for await (const chunk of body) {
    if (length + chunk.byteLength > limit) throw new TypeError("a client's metadata is too large");
    bytes.set(chunk, length);
    length += chunk.byteLength;
  }
  return bytes.subarray(0, length);
}

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
