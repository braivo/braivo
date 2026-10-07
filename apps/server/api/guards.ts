// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Who a request is, and what a route admits: the host, the session, and the
// middleware a route lists before its handler (its body's limit, the
// forged-write checks, the cache header), with `jsonBody` to read what a JSON
// write admitted. Shared by every group of routes; a helper one group uses
// stays in that group.

import type { Database } from "@braivo/db";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import { resumeLearnerSession, type RequestHost } from "../application/index.ts";
import { type Auth, isOrganizationOrigin } from "../auth/index.ts";

/**
 * Whether a state-changing request came from somewhere allowed to make it.
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-site POST from
 * carrying it but not a same-site one — and a sibling subdomain is same-site.
 * Two cheap checks close that gap. A browser cannot set `application/json`
 * cross-origin without a preflight this server never answers, and when it does
 * send an `Origin` it has to be ours. A server-to-server caller sends no
 * `Origin` at all and sets the content type, so neither check touches it.
 * Besides this installation's origin, an organization's domain serves the
 * learn app (ADR 0004); it writes only to itself, as its learner session.
 */
async function isTrustedWrite(
  context: Context,
  origin: string,
  database: Database,
  host: RequestHost,
): Promise<boolean> {
  // The media type alone, so that `application/json; charset=utf-8` is accepted
  // and `application/jsonp` is not — a prefix test would take both.
  const mediaType = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
  if (mediaType.trim().toLowerCase() !== "application/json") return false;

  // Each app calls its own origin's API, so a write comes from the host it is
  // sent to: a learn domain cannot write through the console's session.
  const requestOrigin = context.req.header("origin");
  if (requestOrigin === undefined) return true;
  if (host.installation) return requestOrigin === origin;
  return (
    URL.canParse(requestOrigin) &&
    new URL(requestOrigin).hostname === host.hostname &&
    isOrganizationOrigin(database, requestOrigin)
  );
}

/**
 * `isTrustedWrite` for a body that is a file rather than JSON. What a browser
 * sends cross-site without a preflight is a form's content type or none, so
 * an upload must name another; `text/plain` falls to that rule, which costs
 * nothing, since text is sent as a source rather than kept as a file.
 */
function isTrustedUpload(context: Context, origin: string): boolean {
  const mediaType = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
  const simple = ["", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];
  if (simple.includes(mediaType.trim().toLowerCase())) return false;

  const requestOrigin = context.req.header("origin");
  return requestOrigin === undefined || requestOrigin === origin;
}

/** Enough for that many records, and far less than a body worth buffering. */
export const MAX_BODY_BYTES = 1_000_000;

/** 413 past `maxSize` bytes, declared or sent. */
export const limitBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (context) => context.body(null, 413) });

/**
 * `Cache-Control: private, no-store` on whatever the route answers. Set on the
 * answer once there is one, so it reaches a `Response` a handler builds itself
 * and the 500 Hono makes of a throw, a failed session lookup's included. One
 * URL, a different answer per cookie, and a `Cookie` request header does not
 * by itself stop a shared cache handing one learner another's (ADR 0010).
 */
export const noStore = createMiddleware(async (context, next) => {
  await next();
  context.header("cache-control", "private, no-store");
});

/** The request's JSON body, or `undefined` when it is not JSON, for a parser to refuse. */
export const jsonBody = (context: Context): Promise<unknown> =>
  context.req.json().catch(() => undefined);

/**
 * A learn domain's cookies (ADR 0018), each `__Host-`: Secure, on that host
 * alone, for every path. `Lax`, since the handoff arrives by a navigation from
 * the installation's origin.
 */
export const LEARNER_COOKIE = "braivo-learner";
export const HANDOFF_COOKIE = "braivo-handoff";
export const cookieOptions = (expiresAt: Date) =>
  ({
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    expires: expiresAt,
  }) as const;

/** What the guards need: the installation's sessions, database, and public origin. */
type GuardOptions = { auth: Auth; database: Database; baseUrl: string };

/** The guards `createApi` builds once and hands to each group of routes. */
export type Guards = ReturnType<typeof createGuards>;

export function createGuards({ auth, database, baseUrl }: GuardOptions) {
  const origin = new URL(baseUrl).origin;
  const installationHostname = new URL(baseUrl).hostname;

  /** The host a request was sent to, which `application`'s `hostAdmits` limits routes by. */
  const requestHost = (context: Context): RequestHost => {
    const { hostname } = new URL(context.req.url);
    return { hostname, installation: hostname === installationHostname };
  };

  /**
   * The session behind a request, with Better Auth's renewal cookies forwarded.
   * It renews past the update interval and answers with a replacement cookie;
   * calling its API directly means that header arrives here, and dropping it
   * would sign out a client that only ever calls these routes, however active.
   */
  async function sessionFor(context: Context) {
    // A learn domain holds learner sessions alone (ADR 0018): an account's
    // cookie there counts for nothing.
    if (!requestHost(context).installation) return null;
    const { headers, response } = await auth.api.getSession({
      headers: context.req.raw.headers,
      returnHeaders: true,
    });

    // Not to a bearer, which renews by being used, and must not be handed a
    // cookie it could carry where tokens are refused.
    if (context.req.header("authorization") !== undefined) return response;
    for (const cookie of headers.getSetCookie()) {
      context.header("set-cookie", cookie, { append: true });
    }
    return response;
  }

  /**
   * The learner behind a request to a learner route: on a learn domain, its
   * learner session's user, renewed as it is used; on the installation's host,
   * the account's (the console reading a learner's progress; the learn app in
   * development).
   */
  async function learnerFor(context: Context): Promise<{ id: string; name: string } | undefined> {
    const host = requestHost(context);
    if (host.installation) {
      const user = (await sessionFor(context))?.user;
      return user && { id: user.id, name: user.name };
    }

    const token = getCookie(context, LEARNER_COOKIE, "host");
    if (token === undefined) return undefined;
    const found = await resumeLearnerSession({
      database,
      hostname: host.hostname,
      token,
      now: new Date(),
    });
    if (found?.renewedUntil) {
      setCookie(context, LEARNER_COOKIE, token, cookieOptions(found.renewedUntil));
    }
    return found?.user;
  }

  // What a route admits, named once and listed in the order it runs: a limit,
  // then the forged-write check, then the session. Before the session is even
  // resolved, a forged write costs this server nothing, and its refusal does
  // not depend on who it claims to be.

  /** Refuses a write that may be forged: `isTrustedWrite`, 403. */
  const trustedWrite = createMiddleware(async (context, next) => {
    if (!(await isTrustedWrite(context, origin, database, requestHost(context)))) {
      return context.body(null, 403);
    }
    await next();
  });

  /** A JSON write from a browser or a tool: limited, then refused if possibly forged. */
  const trustedJsonWrite = (maxSize = MAX_BODY_BYTES) =>
    [limitBody(maxSize), trustedWrite] as const;

  /** As `trustedWrite`, for a body that is a file: `isTrustedUpload`, 403. */
  const trustedUpload = createMiddleware(async (context, next) => {
    if (!isTrustedUpload(context, origin)) return context.body(null, 403);
    await next();
  });

  /**
   * An account's session on the installation's host, cookie or token
   * (`sessionFor`); 401 without one. Its user is `userId`.
   */
  const requireAccount = createMiddleware<{ Variables: { userId: string } }>(
    async (context, next) => {
      const session = await sessionFor(context);
      if (!session) return context.body(null, 401);
      context.set("userId", session.user.id);
      await next();
    },
  );

  /** A learner, as `learnerFor` finds one; 401 without one. */
  const requireLearner = createMiddleware<{
    Variables: { learner: { id: string; name: string } };
  }>(async (context, next) => {
    const learner = await learnerFor(context);
    if (!learner) return context.body(null, 401);
    context.set("learner", learner);
    await next();
  });

  return {
    requestHost,
    sessionFor,
    /** `isTrustedWrite` for a route that checks it itself, among other things. */
    isTrustedWrite: (context: Context) =>
      isTrustedWrite(context, origin, database, requestHost(context)),
    trustedJsonWrite,
    trustedUpload,
    requireAccount,
    requireLearner,
  };
}
