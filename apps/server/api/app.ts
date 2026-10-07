// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  type Ai,
  readHostOrganization,
  redeemHandoff,
  startHandoff,
} from "../application/index.ts";
import type { Auth } from "../auth/index.ts";
import type { FileStore } from "../storage/index.ts";
import { authoringRoutes } from "./authoring.ts";
import {
  cookieOptions,
  createGuards,
  HANDOFF_COOKIE,
  LEARNER_COOKIE,
  limitBody,
  MAX_BODY_BYTES,
  noStore,
} from "./guards.ts";
import { learningRoutes } from "./learning.ts";
import { materialsRoutes } from "./materials.ts";

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
 * The HTTP entry point to `application`. A route resolves who is asking, calls
 * one use case, and turns its result into a status; anything it had to look up
 * for itself would be a workflow, and workflows belong to `application`.
 *
 * A factory rather than a module-level app, so nothing reads the environment at
 * import time and a test can serve its own database.
 *
 * Endpoints and statuses: `index.ts`. Why any of it: ADR 0010.
 */
export function createApi(options: ApiOptions) {
  const { auth, database, cachedDatabase = database, files, ai } = options;
  const origin = new URL(options.baseUrl).origin;
  const api = new Hono();
  const guards = createGuards(options);
  const { requestHost, sessionFor, isTrustedWrite, requireLearner } = guards;

  // The installation's origin is the console's and its tools': the account's
  // own credentials — Better Auth, a bearer token — and the console's API reach
  // nothing on any other host, which serves one organization's learn app and
  // holds learner sessions alone (ADR 0004, ADR 0018, ADR 0022). Before
  // authentication, so a credential presented elsewhere is refused whatever it
  // could do.
  api.use("/api/*", async (context, next) => {
    if (requestHost(context).installation) return next();
    // A refusal here depends on the host, so no shared cache may keep one.
    context.header("cache-control", "private, no-store");
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

  // Better Auth owns the routing below this path (ADR 0006); Braivo still owes
  // it the protections. Unguarded, `sign-in/email-otp` accepts a megabytes-long
  // name unauthenticated, and `organization/list` answers with one caller's
  // organizations under no cache header at all.
  api.on(
    ["GET", "POST"],
    "/api/auth/*",
    // Set on every answer, Braivo's own refusals below included, not only the
    // ones Better Auth leaves bare: nothing under this mount is public with the
    // plugins in use, and exempting a header that already said `no-store` only
    // ever skipped this same value.
    async (context, next) => {
      await next();
      context.res.headers.set("cache-control", "private, no-store");
    },
    limitBody(MAX_BODY_BYTES),
    async (context) => {
      // A tool's token is for Braivo's API and for finding its way there, not
      // for managing the account — approving another device, changing an
      // email — which takes the person in their browser.
      const bearer = context.req.header("authorization") !== undefined;
      if (bearer && !BEARER_AUTH_PATHS.has(context.req.path)) return context.body(null, 403);
      if (SIGN_IN_PATHS.has(context.req.path) && !(await isTrustedWrite(context))) {
        return context.body(null, 403);
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
    },
  );

  /**
   * How `/login` may sign people in besides an emailed code, which is always
   * offered: with Google, when the installation has an OAuth client for it.
   * The console is built once for any installation, so it asks.
   */
  api.get("/api/sign-in-methods", (context) =>
    context.json({ google: auth.options.socialProviders?.google !== undefined }),
  );

  /**
   * Starts a learn domain's sign-in (ADR 0018): records where it began, gives
   * the browser the nonce that alone may redeem the code, and sends it to the
   * installation's `/login`. A navigation, so it answers redirects.
   */
  api.get("/api/session/sign-in", noStore, async (context) => {
    const host = requestHost(context);
    if (host.installation) return context.body(null, 404);

    const started = await startHandoff({
      database,
      hostname: host.hostname,
      returnPath: context.req.query("redirect"),
      now: new Date(),
    });
    if (!started) return context.body(null, 404);

    setCookie(context, HANDOFF_COOKIE, started.nonce, cookieOptions(started.expiresAt));
    return context.redirect(`${origin}/login?handoff=${started.handoffId}`);
  });

  /**
   * Ends a learn domain's sign-in: redeems the code the installation's origin
   * issued, with the nonce cookie its browser kept, as a learner session, and
   * goes where the learner started, so no page loads with the code in its URL.
   */
  api.get("/api/session/handoff", noStore, async (context) => {
    context.header("referrer-policy", "no-referrer");
    const host = requestHost(context);
    if (host.installation) return context.body(null, 404);

    const code = context.req.query("code");
    const nonce = getCookie(context, HANDOFF_COOKIE, "host");
    const redeemed =
      code && nonce
        ? await redeemHandoff({
            database,
            hostname: host.hostname,
            code,
            nonce,
            now: new Date(),
          })
        : undefined;
    // A person followed a redirect here. The learn app says it failed and
    // offers to sign in again; Back would only reach the spent handoff.
    if (!redeemed) return context.redirect("/login?failed=1");

    // Only once spent: after a failure, it may be a later sign-in's, begun in
    // another tab, that one cookie holds.
    deleteCookie(context, HANDOFF_COOKIE, { prefix: "host" });
    setCookie(context, LEARNER_COOKIE, redeemed.token, cookieOptions(redeemed.expiresAt));
    return context.redirect(redeemed.returnPath);
  });

  /** Who is signed in, as the learn app asks: the learner session's user, or the account's. */
  api.get("/api/session", noStore, requireLearner, (context) =>
    context.json({ user: context.var.learner }),
  );

  /**
   * Signs out of the host asked: a learn domain's learner session, or the
   * account. A browser's only: a tool's token manages no account (ADR 0022).
   */
  api.post("/api/session/sign-out", async (context) => {
    if (context.req.header("authorization") !== undefined) return context.body(null, 403);
    if (!(await isTrustedWrite(context))) return context.body(null, 403);

    if (requestHost(context).installation) {
      const { headers } = await auth.api.signOut({
        headers: context.req.raw.headers,
        returnHeaders: true,
      });
      for (const cookie of headers.getSetCookie()) {
        context.header("set-cookie", cookie, { append: true });
      }
      return context.body(null, 204);
    }

    const token = getCookie(context, LEARNER_COOKIE, "host");
    if (token !== undefined) await endLearnerSession({ database, token });
    deleteCookie(context, LEARNER_COOKIE, { prefix: "host" });
    return context.body(null, 204);
  });

  /**
   * What a learn domain's sign-in signs in to, for the installation's `/login`
   * to say: the organization's name and the domain it returns to.
   */
  api.get("/api/handoffs/:handoffId", noStore, async (context) => {
    const found = await describeHandoff({
      database,
      handoffId: context.req.param("handoffId"),
      now: new Date(),
    });
    return found ? context.json(found) : context.body(null, 404);
  });

  /**
   * Hands the signed-in account over to a learn domain as a learner, if it is
   * a member there: answers the URL to go to. A write from a click on
   * `/login`, never a navigation, so no link hands someone over unasked; and
   * a browser's, since a tool's token manages no account (ADR 0022).
   */
  api.post("/api/handoffs/:handoffId", noStore, async (context) => {
    if (context.req.header("authorization") !== undefined) return context.body(null, 403);
    if (!(await isTrustedWrite(context))) return context.body(null, 403);

    const session = await sessionFor(context);
    if (!session) return context.body(null, 401);

    const completed = await completeHandoff({
      database,
      handoffId: context.req.param("handoffId"),
      userId: session.user.id,
      now: new Date(),
    });
    switch (completed.kind) {
      case "unavailable":
        return context.body(null, 404);
      case "not-member":
        return context.body(null, 403);
      case "issued":
        return context.json({
          url: `https://${completed.hostname}/api/session/handoff?code=${completed.code}`,
        });
      default:
        throw new Error(`Unhandled answer: ${JSON.stringify(completed satisfies never)}`);
    }
  });

  /**
   * The organization this request's host serves, which a learn app on that
   * domain is branded as. No session: the domain is public and so is its name.
   * The host is the request URL's, so a router in front must forward `Host`.
   * Still `noStore`: the same URL names a different organization on every
   * domain, and a rename should show on the next load.
   */
  api.get("/api/organization", noStore, async (context) => {
    const found = await readHostOrganization({
      database,
      hostname: new URL(context.req.url).hostname,
    });

    return found ? context.json(found) : context.body(null, 404);
  });

  // A group's routes, after the host gate: Hono runs what was registered first.
  api.route("/", learningRoutes(guards, { database }));
  api.route("/", authoringRoutes(guards, { database }));
  api.route("/", materialsRoutes(guards, { database, cachedDatabase, files, ai }));

  return api;
}

export type Api = ReturnType<typeof createApi>;
