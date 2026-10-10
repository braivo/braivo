// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { getIP } from "@better-auth/core/utils/ip";
import type { Database } from "@braivo/db";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import * as z from "zod";

import {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  nameNewLearner,
  redeemHandoff,
  sendLearnerSignInCode,
  signInLearner,
  startHandoff,
} from "../application/index.ts";
import { type Auth, SIGN_IN_CODE } from "../auth/index.ts";
import { mailLocale, type SendMail } from "../mail/index.ts";
import { cookieOptions, type Guards, HANDOFF_COOKIE, jsonBody, LEARNER_COOKIE } from "./guards.ts";
import type { SignInSettings } from "./types.ts";

type SessionOptions = {
  auth: Auth;
  database: Database;
  /** The installation's public origin, where a learn domain's sign-in goes. */
  baseUrl: string;
  /** The privacy policy and terms `/login` links, or none. */
  legal?: NonNullable<SignInSettings["legal"]>;
  /** Sends a learn domain's sign-in codes. */
  sendMail: SendMail;
};

/** The longest name a learn domain's sign-in gives a new account. */
const MAX_NAME_LENGTH = 200;

const sendCodeBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });
const signInBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  code: z.string().regex(new RegExp(`^\\d{${SIGN_IN_CODE.digits}}$`)),
});
const nameBody = z.object({ name: z.string().trim().min(1).max(MAX_NAME_LENGTH) });

/**
 * At most `max` requests a minute to a route from one client, told apart as
 * Better Auth's limiter tells them (`getIP`: `X-Forwarded-For`, true only
 * behind a proxy that sets it, IPv6 by its /64); unlimited for one it cannot
 * tell. Counts are dropped whole each minute: one lookup a request, one
 * minute's clients in memory. Per process and best effort, as Better Auth's
 * are; the database holds the one code a minute per address.
 */
function perClientLimit(auth: Auth, max: number) {
  let counts = new Map<string, number>();
  let minuteEndsAt = 0;
  return createMiddleware(async (context, next) => {
    const client = getIP(context.req.raw, auth.options);
    if (!client) return next();
    const now = Date.now();
    if (now >= minuteEndsAt) {
      counts = new Map();
      minuteEndsAt = now + 60_000;
    }
    const count = (counts.get(client) ?? 0) + 1;
    if (count > max) return context.body(null, 429);
    counts.set(client, count);
    return next();
  });
}

/** Sized as Better Auth's code limits: a school's classes behind one address (access-2). */
const CLIENT_LIMIT = 120;

/**
 * Braivo's session routes: what `/login` offers, a learn domain's sign-in, by
 * a code it sends or handed off through the installation's `/login` (ADR
 * 0018), who is signed in, and signing out.
 * Better Auth answers `/api/auth/*` itself.
 */
export function sessionRoutes(
  { requestHost, sessionFor, isTrustedWrite, trustedJsonWrite, requireLearner }: Guards,
  { auth, database, baseUrl, legal, sendMail }: SessionOptions,
) {
  const origin = new URL(baseUrl).origin;
  const routes = new Hono();

  /** 404 on the installation's host, which signs in through Better Auth. */
  const learnDomainOnly = createMiddleware(async (context, next) =>
    requestHost(context).installation ? context.body(null, 404) : next(),
  );

  /**
   * What `/login` offers besides an emailed code, which it always does: Google,
   * when the installation has an OAuth client for it, and the operator's
   * privacy policy and terms to agree to. The console is built once for any
   * installation, so it asks.
   */
  routes.get("/api/sign-in-settings", (context) =>
    context.json<SignInSettings>({
      google: auth.options.socialProviders?.google !== undefined,
      legal: legal ?? null,
    }),
  );

  /**
   * Sends a code that signs in on this learn domain alone, to any address,
   * saying nothing of whether it has an account or is a member here.
   */
  routes.post(
    "/api/session/code",
    learnDomainOnly,
    perClientLimit(auth, CLIENT_LIMIT),
    ...trustedJsonWrite(),
    async (context) => {
      const parsed = sendCodeBody.safeParse(await jsonBody(context));
      if (!parsed.success) return context.body(null, 400);

      const sent = await sendLearnerSignInCode({
        database,
        secret: (await auth.$context).secret,
        sendMail,
        hostname: requestHost(context).hostname,
        email: parsed.data.email,
        locale: mailLocale(context.req.header("accept-language")),
        now: new Date(),
      });
      switch (sent.kind) {
        case "sent":
          return context.body(null, 204);
        case "unavailable":
          return context.body(null, 404);
        case "cooldown":
          return context.json(
            {
              error: "Wait a minute before asking for a code again.",
              code: "SIGN_IN_CODE_COOLDOWN",
            },
            429,
          );
        case "send-failed":
          // The address still waits its minute, as on the installation's host.
          return context.json(
            {
              error: "The code could not be sent. Try again in a minute.",
              code: "SIGN_IN_CODE_SEND_FAILED",
            },
            503,
          );
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(sent satisfies never)}`);
      }
    },
  );

  /**
   * Signs in on this learn domain with the code it sent: a member gets a
   * learner session here, and the account's name, which may be empty, to be
   * named next. Refusals carry Better Auth's codes for the same, which the
   * sign-in form words, and `NOT_A_MEMBER`, after which the code still works.
   */
  routes.post(
    "/api/session/sign-in",
    learnDomainOnly,
    perClientLimit(auth, CLIENT_LIMIT),
    ...trustedJsonWrite(),
    async (context) => {
      const parsed = signInBody.safeParse(await jsonBody(context));
      if (!parsed.success) return context.body(null, 400);

      const signedIn = await signInLearner({
        database,
        auth,
        secret: (await auth.$context).secret,
        hostname: requestHost(context).hostname,
        ...parsed.data,
        now: new Date(),
      });
      switch (signedIn.kind) {
        case "signed-in":
          setCookie(context, LEARNER_COOKIE, signedIn.token, cookieOptions(signedIn.expiresAt));
          return context.json({ user: signedIn.user });
        case "wrong":
          return context.json({ error: "Invalid code.", code: "INVALID_OTP" }, 400);
        case "expired":
          return context.json({ error: "The code has expired.", code: "OTP_EXPIRED" }, 400);
        case "guessed-out":
          return context.json(
            { error: "The code was tried too many times.", code: "TOO_MANY_ATTEMPTS" },
            403,
          );
        case "not-member":
          return context.json(
            { error: "This account is not a member here.", code: "NOT_A_MEMBER" },
            403,
          );
        default:
          throw new Error(`Unhandled answer: ${JSON.stringify(signedIn satisfies never)}`);
      }
    },
  );

  /**
   * Names the account signed in on this learn domain, only while it has no
   * name: the sign-in's last step for a new account. 409 once it has one.
   */
  routes.post(
    "/api/session/name",
    learnDomainOnly,
    ...trustedJsonWrite(),
    requireLearner,
    async (context) => {
      const parsed = nameBody.safeParse(await jsonBody(context));
      if (!parsed.success) {
        return context.json({ error: "Enter a name.", code: "NAME_INVALID" }, 400);
      }
      const named = await nameNewLearner({
        database,
        userId: context.var.learner.id,
        name: parsed.data.name,
        now: new Date(),
      });
      return named
        ? context.body(null, 204)
        : context.json({ error: "This account has a name.", code: "ALREADY_NAMED" }, 409);
    },
  );

  /**
   * Starts a learn domain's sign-in through the installation's `/login` (ADR
   * 0018), which Google's needs, its callback being there: records where it
   * began, gives the browser the nonce that alone may redeem the code, and
   * sends it there. A navigation, so it answers redirects.
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
    // `provider=google`: the learner chose Google, which that page then starts.
    const google = context.req.query("provider") === "google" ? "&provider=google" : "";
    return context.redirect(`${origin}/login?handoff=${started.handoffId}${google}`);
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
