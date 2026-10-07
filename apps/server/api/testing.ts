// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support for the API's suites. Nothing here is part of the server's
// behaviour.

import * as testing from "@braivo/db/testing";

import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import { type Api, createApi } from "./app.ts";

/** The test database; a suite needing it is skipped without one. */
export const connectionString = process.env.TEST_DATABASE_URL;
export const baseUrl = "http://localhost:3000";

/** Named apart from its email, so an answer naming the wrong one fails. */
export type Signed = { cookie: string; token: string; id: string; email: string; name: string };

/**
 * An API on the test database, with what every suite repeats: Better Auth
 * mailing its codes to `outbox`, and `signUp`. A suite seeds its own
 * organizations and courses.
 */
export function createTestApi() {
  const database = testing.sharedDatabase(connectionString ?? "");
  const outbox = createOutbox();
  const auth = createAuth({
    database,
    secret: "api-test-secret-that-is-long-enough-32",
    baseURL: baseUrl,
    sendMail: outbox.sendMail,
  });
  const api = createApi({ auth, database, baseUrl });

  /**
   * Makes a new account and signs it in by code through the mounted Better
   * Auth handler, so a suite holds a real session rather than a seeded one. A
   * fresh email each call, so a rerun never collides with a leftover account
   * or its address's minute between codes.
   */
  async function signUp(): Promise<Signed> {
    const id = crypto.randomUUID();
    const email = `api-test-${id}@example.com`;
    const name = `Learner ${id.slice(0, 8)}`;
    const request = (path: string, init: RequestInit) => api.request(`/api/auth${path}`, init);
    return { ...(await signInWithCode(request, outbox, { email, name })), email, name };
  }

  return { database, outbox, auth, api, signUp };
}

/**
 * Hands the account signed in by `accountCookie` over to a learn domain as a learner,
 * the way a browser is (ADR 0018): started there, completed on the
 * installation's origin, redeemed there with the nonce cookie. Answers the
 * learner session's cookie.
 */
export async function learnerSessionOn(
  api: Api,
  learnOrigin: string,
  accountCookie: string,
): Promise<string> {
  /** The cookie `name` as a browser sends it back. */
  const pair = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((set) => set.startsWith(`${name}=`))!
      .split(";", 1)[0]!;

  const started = await api.request(`${learnOrigin}/api/session/sign-in?redirect=/`);
  // `/login` on the installation's origin, which completes the handoff.
  const login = new URL(started.headers.get("location")!);
  const completed = await api.request(
    `${login.origin}/api/handoffs/${login.searchParams.get("handoff")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: login.origin, cookie: accountCookie },
    },
  );
  if (!completed.ok) throw new Error(`Completing the handoff answered ${completed.status}.`);
  const { url } = (await completed.json()) as { url: string };
  const redeemed = await api.request(url, {
    headers: { cookie: pair(started, "__Host-braivo-handoff") },
  });
  return pair(redeemed, "__Host-braivo-learner");
}
