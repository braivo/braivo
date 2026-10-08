// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { type Ai, readHostOrganization } from "../application/index.ts";
import type { Auth } from "../auth/index.ts";
import type { FileStore } from "../storage/index.ts";
import { authoringRoutes } from "./authoring.ts";
import { createGuards, limitBody, MAX_BODY_BYTES, refuseUnstorable } from "./guards.ts";
import { learningRoutes } from "./learning.ts";
import { materialsRoutes } from "./materials.ts";
import { sessionRoutes } from "./session.ts";

type ApiOptions = {
  auth: Auth;
  database: Database;
  /**
   * For reads that cannot go stale, such as a source, which never changes:
   * a query cache in front of it, like Hyperdrive's, serves them without
   * asking the database, and is never told of a write. Defaults to `database`.
   */
  cachedDatabase?: Database;
  /** The public origin this installation is served from, used to judge writes. */
  baseUrl: string;
  /** Where uploaded files are kept; without one, the file routes answer 501. */
  files?: FileStore;
  /** The installation's model, and who may use it; without one, AI routes answer 501. */
  ai?: Ai;
};

/**
 * What Better Auth answers a bearer token: who it is, and signing its own
 * session out (`braivo logout`). A tool finds its organizations at Braivo's
 * `GET /api/organizations`.
 */
const BEARER_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-out",
]);

/**
 * Signing in, which Better Auth origin-checks only for a request carrying a
 * cookie: without `isTrustedWrite`, another site could sign a visitor in to an
 * account whose code it holds, or start Google's sign-in in their browser.
 */
const SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
  "/api/auth/sign-in/social",
]);

/**
 * `Cache-Control: private, no-store`, on every answer under `/api`. Set on the
 * answer once there is one, so it reaches a `Response` a handler builds itself
 * and the 500 Hono makes of an uncaught `Error`, a failed session lookup's
 * included. One URL, a different answer per cookie, and a `Cookie` request
 * header does not by itself stop a shared cache handing one learner another's
 * (ADR 0010).
 */
const noStore = createMiddleware(async (context, next) => {
  await next();
  context.header("cache-control", "private, no-store");
});

/**
 * The HTTP entry point to `application`. A route resolves who is asking, hands
 * the work to one use case, or to Better Auth for the account's own session,
 * and turns the answer into a status; anything it had to look up for itself
 * would be a workflow, and workflows belong to `application`.
 *
 * A factory rather than a module-level app, so nothing reads the environment at
 * import time and a test can serve its own database.
 *
 * Endpoints and statuses: `index.ts`. Why any of it: ADR 0010.
 */
export function createApi(options: ApiOptions) {
  const { auth, database, baseUrl, cachedDatabase = database, files, ai } = options;
  const api = new Hono();
  const guards = createGuards(options);
  const { requestHost, isTrustedWrite } = guards;

  // First, so it reaches every answer under `/api`, the refusals below and
  // Hono's 404 included: none is meant for a shared cache (ADR 0010).
  api.use("/api/*", noStore);

  // The installation's origin is the console's and its tools': the account's
  // own credentials — Better Auth, a bearer token — and the console's API reach
  // nothing on any other host, which serves one organization's learn app and
  // holds learner sessions alone (ADR 0004, ADR 0018, ADR 0022). Before
  // authentication, so a credential presented elsewhere is refused whatever it
  // could do.
  api.use("/api/*", async (context, next) => {
    if (requestHost(context).installation) return next();
    if (context.req.header("authorization") !== undefined) return context.body(null, 401);
    const { path } = context.req;
    const installationOnly = [
      "/api/organizations",
      "/api/auth",
      "/api/handoffs",
      "/api/sign-in-methods",
    ];
    if (installationOnly.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return context.body(null, 404);
    }
    return next();
  });

  // A NUL, which PostgreSQL refuses as a 500, reaches a URL only as `%00`,
  // so it is read before anything decodes it. In the path it names nothing
  // stored (`isStorable`); in the query, a value no lookup can match, such as
  // Better Auth's `user_code`. After the host gate, whose refusals come first.
  api.use("/api/*", async (context, next) => {
    const { pathname, search } = new URL(context.req.url);
    if (pathname.includes("%00")) return context.body(null, 404);
    if (search.includes("%00")) return context.body(null, 400);
    return next();
  });

  // Better Auth owns the routing below this path (ADR 0006); Braivo still owes
  // it the protections. Unguarded, `sign-in/email-otp` accepts a megabytes-long
  // name unauthenticated, and `organization/list` answers with one caller's
  // organizations under no cache header at all. `noStore` above replaces
  // whatever header Better Auth set: nothing here is public with its plugins.
  api.on(["GET", "POST"], "/api/auth/*", limitBody(MAX_BODY_BYTES), async (context) => {
    // A tool's token is for Braivo's API and for finding its way there, not
    // for managing the account — approving another device, changing an
    // email — which takes the person in their browser.
    const bearer = context.req.header("authorization") !== undefined;
    if (bearer && !BEARER_AUTH_PATHS.has(context.req.path)) return context.body(null, 403);
    if (SIGN_IN_PATHS.has(context.req.path) && !(await isTrustedWrite(context))) {
      return context.body(null, 403);
    }
    // As `storableJson` does for Braivo's routes: a name with a NUL would be a
    // 500. Read from a copy, since Better Auth reads the request itself.
    if (context.req.method === "POST") {
      const body = await context.req.raw
        .clone()
        .json()
        .catch(() => undefined);
      const refused = refuseUnstorable(context, body);
      if (refused) return refused;
    }

    // Copied, since a library's response may carry immutable headers.
    const answered = await auth.handler(context.req.raw);
    const response = new Response(answered.body, answered);
    // A renewed session comes back as a signed cookie, which the bearer
    // plugin also copies into `set-auth-token`: either would carry a token's
    // session past every limit set on bearers here.
    if (bearer) {
      response.headers.delete("set-cookie");
      response.headers.delete("set-auth-token");
    }
    return response;
  });

  /**
   * The organization this request's host serves, which a learn app on that
   * domain is branded as. No session: the domain is public and so is its name.
   * The host is the request URL's, so a router in front must forward `Host`.
   * Uncacheable all the same: the same URL names a different organization on
   * every domain, and a rename should show on the next load.
   */
  api.get("/api/organization", async (context) => {
    const found = await readHostOrganization({
      database,
      hostname: new URL(context.req.url).hostname,
    });

    return found ? context.json(found) : context.body(null, 404);
  });

  // After the host gate, which runs only before routes registered after it.
  api.route("/", sessionRoutes(guards, { auth, database, baseUrl }));
  api.route("/", learningRoutes(guards, { database }));
  api.route("/", authoringRoutes(guards, { database }));
  api.route("/", materialsRoutes(guards, { database, cachedDatabase, files, ai }));

  return api;
}

export type Api = ReturnType<typeof createApi>;
