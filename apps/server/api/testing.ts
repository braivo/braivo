// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Test support for the API's suites. Nothing here is part of the server's
// behaviour.

import type { Api } from "./app.ts";

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
