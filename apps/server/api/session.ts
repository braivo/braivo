// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  redeemHandoff,
  startHandoff,
} from "../application/index.ts";
import type { Auth } from "../auth/index.ts";
import { cookieOptions, type Guards, HANDOFF_COOKIE, LEARNER_COOKIE } from "./guards.ts";

type SessionOptions = {
  auth: Auth;
  database: Database;
  /** The installation's public origin, where a learn domain's sign-in goes. */
  baseUrl: string;
};

/**
 * Braivo's session routes: which sign-in methods `/login` offers, a learn
 * domain's sign-in handed off through it (ADR 0018), who is signed in, and
 * signing out. Better Auth answers `/api/auth/*` itself.
 */
export function sessionRoutes(
  { requestHost, sessionFor, isTrustedWrite, requireLearner }: Guards,
  { auth, database, baseUrl }: SessionOptions,
) {
  const origin = new URL(baseUrl).origin;
  const routes = new Hono();

  /**
   * How `/login` may sign people in besides an emailed code, which is always
   * offered: with Google, when the installation has an OAuth client for it.
   * The console is built once for any installation, so it asks.
   */
  routes.get("/api/sign-in-methods", (context) =>
    context.json({ google: auth.options.socialProviders?.google !== undefined }),
  );

  /**
   * Starts a learn domain's sign-in (ADR 0018): records where it began, gives
   * the browser the nonce that alone may redeem the code, and sends it to the
   * installation's `/login`. A navigation, so it answers redirects.
   */
  routes.get("/api/session/sign-in", async (context) => {
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
  routes.get("/api/session/handoff", async (context) => {
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
  routes.get("/api/session", requireLearner, (context) =>
    context.json({ user: context.var.learner }),
  );

  /**
   * Signs out of the host asked: a learn domain's learner session, or the
   * account. A browser's only: a tool's token manages no account (ADR 0022).
   */
  routes.post("/api/session/sign-out", async (context) => {
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
  routes.get("/api/handoffs/:handoffId", async (context) => {
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
  routes.post("/api/handoffs/:handoffId", async (context) => {
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

  return routes;
}
