// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The session routes (`session.ts`): a learn domain's sign-in handed off
// through the installation's origin, who is signed in, and signing out. Which
// host admits each route is `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { learnerSession } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import {
  baseUrl,
  connectionString,
  createTestApi,
  learnerSessionOn,
  type Signed,
} from "./testing.ts";

const { database, api, signUp } = createTestApi();

const organizationId = "session-test-org";
/** Registered as `organizationId`'s own domain, which serves its learn app. */
const organizationOrigin = "https://session-test.example.com";

let learner!: Signed;

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the session routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    learner = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    // Seeding makes the slug the organization's ID.
    await registerLearnDomain({
      database,
      baseUrl,
      organizationSlug: organizationId,
      hostname: new URL(organizationOrigin).hostname,
    });
  });

  test("hands an account over to a learn domain as a learner, back where it started", async () => {
    const started = await api.request(
      `${organizationOrigin}/api/session/sign-in?redirect=/courses/c1`,
    );
    expect(started.status).toBe(302);
    expect(started.headers.get("cache-control")).toBe("private, no-store");
    const login = new URL(started.headers.get("location")!);
    expect(`${login.origin}${login.pathname}`).toBe(`${baseUrl}/login`);
    const [nonceCookie] = started.headers.getSetCookie();
    expect(nonceCookie).toMatch(
      /^__Host-braivo-handoff=[\w-]+; Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Lax$/,
    );
    const nonce = nonceCookie!.split(";", 1)[0]!;

    const handoff = `${baseUrl}/api/handoffs/${login.searchParams.get("handoff")}`;
    expect(await (await api.request(handoff)).json()).toEqual({
      organization: { name: organizationId },
      hostname: new URL(organizationOrigin).hostname,
    });
    const complete = (headers: Record<string, string>) =>
      api.request(handoff, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, ...headers },
      });
    expect((await complete({})).status).toBe(401);
    const form = { "content-type": "application/x-www-form-urlencoded", cookie: learner.cookie };
    expect((await complete(form)).status).toBe(403);
    // A tool's token, which manages no account, hands nothing over.
    expect((await complete({ authorization: `Bearer ${learner.token}` })).status).toBe(403);
    expect(
      (await complete({ cookie: learner.cookie, origin: "https://evil.example" })).status,
    ).toBe(403);
    // Not even the learn domain itself, a sibling of the installation's on hosted
    // domains: only the console's page completes a handoff.
    expect((await complete({ cookie: learner.cookie, origin: organizationOrigin })).status).toBe(
      403,
    );
    expect((await complete({ cookie: (await signUp()).cookie })).status).toBe(403);
    const completed = await complete({ cookie: learner.cookie });
    const { url } = (await completed.json()) as { url: string };
    expect(url).toMatch(`${organizationOrigin}/api/session/handoff?code=`);

    // Only in the browser that started it, and once; a failure goes back to
    // the learn app's sign-in, with no session.
    const failed = (response: Response) => {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/login?failed=1");
      expect(response.headers.getSetCookie()).toEqual([]);
      // The URL it was asked for holds the code.
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    };
    failed(await api.request(url));
    const redeemed = await api.request(url, { headers: { cookie: nonce } });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe("/courses/c1");
    expect(redeemed.headers.get("referrer-policy")).toBe("no-referrer");
    const sessionCookie = redeemed.headers
      .getSetCookie()
      .find((set) => set.startsWith("__Host-braivo-learner="));
    expect(sessionCookie).toMatch(/; Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Lax$/);
    failed(await api.request(url, { headers: { cookie: nonce } }));

    const signedIn = await api.request(`${organizationOrigin}/api/session`, {
      headers: { cookie: sessionCookie!.split(";", 1)[0]! },
    });
    expect(await signedIn.json()).toEqual({ user: { id: learner.id, name: learner.name } });
  });

  test("lets the latest of two sign-ins begun on one domain finish", async () => {
    // One nonce cookie: the second start replaces the first's.
    const start = async () => {
      const started = await api.request(`${organizationOrigin}/api/session/sign-in`);
      const id = new URL(started.headers.get("location")!).searchParams.get("handoff");
      const completed = await api.request(`${baseUrl}/api/handoffs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, cookie: learner.cookie },
      });
      const { url } = (await completed.json()) as { url: string };
      return { url, nonce: started.headers.getSetCookie()[0]!.split(";", 1)[0]! };
    };
    const first = await start();
    const second = await start();

    const stale = await api.request(first.url, { headers: { cookie: second.nonce } });
    expect(stale.headers.get("location")).toBe("/login?failed=1");
    expect(stale.headers.getSetCookie()).toEqual([]);
    const latest = await api.request(second.url, { headers: { cookie: second.nonce } });
    expect(latest.status).toBe(302);
  });

  test("starts sign-in on a learn domain only, and completes it on the installation's host only", async () => {
    const unknown = "https://api-test-unknown.example.com";

    expect((await api.request(`${baseUrl}/api/session/sign-in`)).status).toBe(404);
    expect((await api.request(`${unknown}/api/session/sign-in`)).status).toBe(404);
    expect((await api.request(`${baseUrl}/api/session/handoff?code=x`)).status).toBe(404);
    expect((await api.request(`${baseUrl}/api/handoffs/x`)).status).toBe(404);

    // A live handoff, reached on the installation's host and nowhere else.
    const started = await api.request(`${organizationOrigin}/api/session/sign-in`);
    const id = new URL(started.headers.get("location")!).searchParams.get("handoff");
    const complete = (origin: string) =>
      api.request(`${origin}/api/handoffs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: learner.cookie },
      });
    expect((await api.request(`${baseUrl}/api/handoffs/${id}`)).status).toBe(200);
    expect((await api.request(`${organizationOrigin}/api/handoffs/${id}`)).status).toBe(404);
    expect((await complete(organizationOrigin)).status).toBe(404);
    expect((await complete(baseUrl)).status).toBe(200);
  });

  test("renews a learner session's cookie once it is a day old, and not before", async () => {
    const cookie = await learnerSessionOn(api, organizationOrigin, learner.cookie);
    const ask = () => api.request(`${organizationOrigin}/api/session`, { headers: { cookie } });
    expect((await ask()).headers.getSetCookie()).toEqual([]);

    // A day older, as the database sees it.
    await database
      .update(learnerSession)
      .set({ expiresAt: new Date(Date.now() + 6 * 86_400_000 - 1000) })
      .where(eq(learnerSession.userId, learner.id));

    const [renewed] = (await ask()).headers.getSetCookie();
    expect(renewed?.split(";", 1)[0]).toBe(cookie);
    const expires = Date.parse(renewed!.match(/Expires=([^;]+)/)![1]!);
    expect(expires).toBeGreaterThan(Date.now() + 7 * 86_400_000 - 60_000);
  });

  test("signs a learner out of the learn domain alone", async () => {
    const cookie = await learnerSessionOn(api, organizationOrigin, learner.cookie);
    const signOut = (origin: string) =>
      api.request(`${organizationOrigin}/api/session/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
      });
    const session = (url: string, cookie: string) =>
      api.request(`${url}/api/session`, { headers: { cookie } });

    expect((await signOut("https://evil.example")).status).toBe(403);
    expect((await session(organizationOrigin, cookie)).status).toBe(200);
    const signedOut = await signOut(organizationOrigin);
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__Host-braivo-learner=;/),
    ]);
    expect((await session(organizationOrigin, cookie)).status).toBe(401);
    expect(await (await session(baseUrl, learner.cookie)).json()).toEqual({
      user: { id: learner.id, name: learner.name },
    });
  });

  test("signs an account out of the installation's host, signed in or not", async () => {
    const account = await signUp();
    const signOut = (headers: Record<string, string> = {}) =>
      api.request(`${baseUrl}/api/session/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, ...headers },
      });

    expect((await signOut()).status).toBe(204);
    // What another site could post, signed in or not, and a tool's token, which
    // manages no account.
    const form = { "content-type": "application/x-www-form-urlencoded" };
    expect((await signOut(form)).status).toBe(403);
    expect((await signOut({ origin: "https://evil.example" })).status).toBe(403);
    expect((await signOut({ ...form, cookie: account.cookie })).status).toBe(403);
    expect((await signOut({ authorization: `Bearer ${account.token}` })).status).toBe(403);
    expect((await signOut({ cookie: account.cookie })).status).toBe(204);
    const after = await api.request(`${baseUrl}/api/session`, {
      headers: { cookie: account.cookie },
    });
    expect(after.status).toBe(401);
  });
});
