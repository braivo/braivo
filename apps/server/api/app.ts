// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { type Ai, readHostOrganization } from "../application/index.ts";
import type { DomainProvisioner } from "../application/index.ts";
import type { Auth } from "../auth/index.ts";
import { describeError } from "../logging.ts";
import type { SendMail } from "../mail/index.ts";
import type { FileStore } from "../storage/index.ts";
import { authoringRoutes } from "./authoring.ts";
import { groupRoutes } from "./groups.ts";
import { createGuards, limitBody, MAX_BODY_BYTES, refuseUnstorable } from "./guards.ts";
import { learningRoutes } from "./learning.ts";
import { materialsRoutes } from "./materials.ts";
import { mcpEndpoint } from "./mcp.ts";
import { sessionRoutes } from "./session.ts";
import type { OrganizationSetup, SignInSettings } from "./types.ts";

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
  /** Serves organizations' own domains once proven (ADR 0038); without one, adding one answers 501. */
  domains?: DomainProvisioner;
  /** The installation's model, and who may use it; without one, AI routes answer 501. */
  ai?: Ai;
  /** Where anyone signed in may set up an organization (ADR 0018); without one, nobody may. */
  selfServeDomain?: string;
  /** Where the installation stores its data, a region code, said at setup; or unsaid. */
  dataRegion?: string;
  /** Regions whose own installations set up organizations, offered at setup (ADR 0040). */
  otherRegions?: OrganizationSetup["otherRegions"];
  /** The privacy policy and terms `/login` links, or none. */
  legal?: NonNullable<SignInSettings["legal"]>;
  /**
   * Sends a learn domain's sign-in codes (ADR 0018), as `createAuth`'s sends
   * the installation's; without one, sending them fails.
   */
  sendMail?: SendMail;
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
 * Where an OAuth client authenticates itself with HTTP Basic (RFC 6749,
 * 2.3.1), as the authorization server's metadata offers: a client's own
 * credential, not a person's session, so a bearer's limits do not apply.
 */
const OAUTH_CLIENT_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/introspect",
  "/api/auth/oauth2/revoke",
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
  const {
    auth,
    database,
    baseUrl,
    cachedDatabase = database,
    files,
    domains,
    ai,
    selfServeDomain,
    dataRegion,
    otherRegions,
    legal,
    sendMail = async () => {
      throw new Error("No mail transport was given to createApi.");
    },
  } = options;
  const api = new Hono();
  const guards = createGuards(options);
  const { requestHost, isTrustedWrite } = guards;

  // Hono's own logs the whole error, whose message may carry personal data
  // (`describeError`). An object, whose fields a log service can filter on.
  api.onError((error, context) => {
    // As Hono's own, keeping headers set before the throw.
    if (error instanceof HTTPException) {
      const response = error.getResponse();
      return context.newResponse(response.body, response);
    }
    console.error({
      message: "Request failed",
      method: context.req.method,
      route: context.req.routePath,
      error: describeError(error),
    });
    return context.text("Internal Server Error", 500);
  });

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
      "/api/organization-setup",
      "/api/auth",
      "/api/handoffs",
      "/api/oauth",
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
    const authorization = context.req.header("authorization");
    const clientBasicAuth =
      OAUTH_CLIENT_PATHS.has(context.req.path) && /^basic /i.test(authorization ?? "");
    const bearer = authorization !== undefined && !clientBasicAuth;
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
      // Better Auth verifies the signed request, then looks up whichever
      // client the body names: only the one the request is for.
      if (context.req.path === "/api/auth/oauth2/public-client-prelogin") {
        const { client_id, oauth_query } = (body ?? {}) as Record<string, unknown>;
        const signedFor = new URLSearchParams(
          typeof oauth_query === "string" ? oauth_query : "",
        ).get("client_id");
        if (client_id !== signedFor) return context.body(null, 400);
      }
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

  // Where Better Auth sends a person to sign in and consent: on to the
  // console's `/consent`, the signed query as one opaque value. The console's
  // router reparses a query (JSON values, repeated keys), which would break
  // the signature over it; `r.` keeps the value from parsing as JSON.
  api.get("/api/oauth/consent", (context) => {
    const signed = new URL(context.req.url).search.slice(1);
    return context.redirect(`/consent?request=r.${Buffer.from(signed).toString("base64url")}`);
  });

  // Where `/mcp`'s tokens come from (RFC 9728), on the installation's host
  // alone, as `/mcp` is. The authorization server's own metadata is Better
  // Auth's, under `/api/auth/.well-known`.
  api.get("/.well-known/oauth-protected-resource/mcp", async (context) => {
    if (!requestHost(context).installation) return context.body(null, 404);
    return auth.handler(context.req.raw);
  });

  const mcp = mcpEndpoint({
    auth,
    database,
    resource: new URL("/mcp", baseUrl).href,
    issuer: new URL("/api/auth", baseUrl).href,
  });
  // Per person, so as uncacheable as `/api`. Refused before anything reads
  // the body: another host, as under `/api`, and a write `isTrustedWrite`
  // doubts, whose `Origin` check MCP's transport requires against DNS
  // rebinding (a client outside a browser sends no `Origin`).
  api.post(
    "/mcp",
    noStore,
    async (context, next) => {
      if (!requestHost(context).installation) return context.body(null, 404);
      return (await isTrustedWrite(context)) ? next() : context.body(null, 403);
    },
    limitBody(MAX_BODY_BYTES),
    (context) => mcp(context.req.raw),
  );

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
  api.route("/", sessionRoutes(guards, { auth, database, baseUrl, legal, sendMail }));
  api.route("/", learningRoutes(guards, { database }));
  api.route(
    "/",
    authoringRoutes(guards, {
      auth,
      database,
      baseUrl,
      selfServeDomain,
      domains,
      dataRegion,
      otherRegions,
      ai,
    }),
  );
  api.route("/", materialsRoutes(guards, { database, cachedDatabase, files, ai }));
  api.route("/", groupRoutes(guards, { database }));

  return api;
}

export type Api = ReturnType<typeof createApi>;
