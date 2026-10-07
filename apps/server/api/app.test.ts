// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// What `app.ts` does itself: Better Auth's mount (signing in by code, a tool's
// device flow), the host gate keeping the console's API off learn domains, and
// `GET /api/organization`. Each route group has its own suite; which host
// admits each route is `policy.test.ts`'s table.

import { runMigrations } from "@braivo/db";
import { session } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { registerLearnDomain } from "../application/index.ts";
import { codeSentTo } from "../auth/testing.ts";
import { createApi } from "./app.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, outbox, auth, api, signUp } = createTestApi();

const organizationId = "api-test-org";
/** Registered as `organizationId`'s own domain, which serves its learn app. */
const organizationOrigin = "https://api-test.example.com";

let learner!: Signed;
/** An admin of the organization, who may add its sources. */
let teacher!: Signed;

/**
 * Outside the database gate below, because it needs none: the session lookup
 * throws before the course ID or the database can matter. The whole of why no
 * custom error handler was added: Hono makes its default 500 inside the
 * middleware chain, so `noStore` still sets the cache header on it, a claim
 * ADR 0010 makes and this is the only thing that checks.
 */
test("carries the cache header even when the session lookup throws", async () => {
  const broken = createApi({
    database,
    baseUrl,
    auth: {
      api: {
        getSession: () => {
          throw new Error("the database is down");
        },
      },
    } as unknown as typeof auth,
  });

  const response = await broken.request("/api/courses/irrelevant/next");

  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("the HTTP API", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    learner = await signUp();
    teacher = await signUp();

    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [learner.id],
      adminIds: [teacher.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });

    // Through the operator's use case, so the domain tests below run on a
    // registered hostname. Seeding makes the slug the organization's ID.
    await registerLearnDomain({
      database,
      baseUrl,
      organizationSlug: organizationId,
      hostname: new URL(organizationOrigin).hostname,
    });
  });

  test("serves Better Auth under its own path", async () => {
    const session = await api.request("/api/auth/get-session", {
      headers: { cookie: learner.cookie },
    });

    expect(await session.json()).toMatchObject({ user: { id: learner.id } });
  });

  test("keeps Better Auth's own answers out of shared caches", async () => {
    // Mounting Better Auth hands it the routing, not the protections: these
    // answer with one caller's organizations and sessions, under whatever cache
    // header the mount puts there.
    for (const path of ["/api/auth/organization/list", "/api/auth/list-sessions"]) {
      const response = await api.request(path, { headers: { cookie: learner.cookie } });

      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  test("bounds the bodies Better Auth will accept", async () => {
    // Signing in makes an account unauthenticated, so without a limit here
    // anyone could make the server buffer and store a name of any size the
    // runtime would tolerate.
    const oversized = await api.request("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `oversized-${crypto.randomUUID()}@example.com`,
        otp: "000000",
        name: "x".repeat(2_000_000),
      }),
    });

    expect(oversized.status).toBe(413);
    // Braivo's own refusal under the mount, so the mount's cache header too.
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
  });

  test("signs in by code only on the installation's origin, and only from it", async () => {
    // Without a cookie Better Auth checks no origin, so another site holding a
    // code for its own address could sign a visitor in to that account.
    const email = `api-test-${crypto.randomUUID()}@example.com`;
    const post = (host: string, path: string, body: unknown, headers: Record<string, string>) =>
      api.request(`${host}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const ours = { origin: baseUrl };
    const foreign = { origin: "https://evil.example" };
    // A form, which a page elsewhere may post without asking.
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const sending = { email, type: "sign-in" };

    const refusedSends = await Promise.all([
      post(baseUrl, "/email-otp/send-verification-otp", sending, foreign),
      post(baseUrl, "/email-otp/send-verification-otp", sending, form),
      // A learn domain hands sign-in to the installation's origin (ADR 0018).
      post(organizationOrigin, "/email-otp/send-verification-otp", sending, {
        origin: organizationOrigin,
      }),
    ]);
    expect(refusedSends.map((answer) => answer.status)).toEqual([403, 403, 404]);
    expect(outbox.sent.filter((sent) => sent.to === email)).toEqual([]);

    const sent = await post(baseUrl, "/email-otp/send-verification-otp", sending, ours);
    expect(sent.status).toBe(200);
    const signingIn = { email, otp: codeSentTo(outbox, email) };
    const refused = await post(baseUrl, "/sign-in/email-otp", signingIn, foreign);
    const signedIn = await post(baseUrl, "/sign-in/email-otp", signingIn, ours);

    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(signedIn.status).toBe(200);
  });

  test("names the organization the request's host serves, and nothing for other hosts", async () => {
    const served = await api.request(`${organizationOrigin}/api/organization`);
    const unserved = await api.request(`${baseUrl}/api/organization`);

    expect(served.status).toBe(200);
    // `seedOrganization` names an organization after its ID.
    expect(await served.json()).toEqual({ name: organizationId });
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(unserved.status).toBe(404);
  });

  test("keeps the console's API and an account's tools on the installation's host", async () => {
    const sources = `/api/organizations/${organizationId}/sources`;
    const at = (origin: string, path: string, headers: Record<string, string> = {}) =>
      api.request(`${origin}${path}`, { headers: { cookie: teacher.cookie, ...headers } });

    expect((await at(baseUrl, sources)).status).toBe(200);
    expect((await at(organizationOrigin, sources)).status).toBe(404);
    expect((await at(organizationOrigin, "/api/organizations")).status).toBe(404);
    expect((await at(baseUrl, "/api/sign-in-methods")).status).toBe(200);
    expect((await at(organizationOrigin, "/api/sign-in-methods")).status).toBe(404);
    const device = await api.request(`${organizationOrigin}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "braivo-cli" }),
    });
    expect(device.status).toBe(404);
    // Any `Authorization` is refused before anything reads it, a learner's route included.
    const bearer = { authorization: "Bearer anything" };
    expect((await at(organizationOrigin, "/api/courses/unknown/next", bearer)).status).toBe(401);
  });

  describe("a content owner's own tools, signed in through the device flow", () => {
    /** What Braivo's CLI sends: JSON, and no cookie, ever. */
    function asCli(path: string, body: Record<string, string>) {
      return api.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    const token = (deviceCode: string) =>
      asCli("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "braivo-cli",
      });

    async function requestCode() {
      const requested = await asCli("/api/auth/device/code", { client_id: "braivo-cli" });
      return (await requested.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
      };
    }

    test("sends the content owner to the console's approval page, code included", async () => {
      const { user_code, verification_uri, verification_uri_complete } = await requestCode();

      expect(verification_uri).toBe(`${baseUrl}/device`);
      const complete = new URL(verification_uri_complete);
      expect(complete.pathname).toBe("/device");
      expect(complete.searchParams.get("user_code")).toBe(user_code);
    });

    test("leaves polling for a token to the device flow's own pacing", () => {
      // Better Auth limits only in production, so the rule is what can be
      // checked here: its generic limit would cut a polling CLI off before its
      // code expires, while the flow answers `slow_down` per code by itself.
      expect(auth.options.rateLimit?.customRules?.["/device/token"]).toBe(false);
    });

    /** The content owner, in their signed-in browser, entering the code the CLI showed. */
    async function approve(userCode: string, cookie = teacher.cookie) {
      await api.request(`/api/auth/device?user_code=${userCode}`, { headers: { cookie } });
      return api.request("/api/auth/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: baseUrl },
        body: JSON.stringify({ userCode }),
      });
    }

    test("acts as the content owner who approved it, over the same API", async () => {
      // Not yet, for a code nobody has approved. A code of its own: polling one
      // twice within its interval answers `slow_down`, as the device flow says.
      const unapproved = await requestCode();
      const pending = await token(unapproved.device_code);
      expect(pending.status).toBe(400);
      expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

      const { device_code, user_code } = await requestCode();
      expect((await approve(user_code)).status).toBe(200);
      const issued = await token(device_code);
      const { access_token } = (await issued.json()) as { access_token: string };
      expect(issued.status).toBe(200);

      const bearer = {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      };
      const added = await api.request(`/api/organizations/${organizationId}/sources`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ title: "Transcript", text: "Hola.", language: "es" }),
      });
      const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: { authorization: `Bearer ${access_token}` },
      });

      expect(added.status).toBe(201);
      expect(listed.status).toBe(200);
      // A code is exchanged once.
      expect((await token(device_code)).status).toBe(400);

      // It finds its way, and manages nothing: approving another code takes the
      // person in their browser.
      const found = await api.request("/api/auth/get-session", {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(found.status).toBe(200);
      // Not even its memberships: a tool's list is Braivo's `/api/organizations`.
      const memberships = await api.request("/api/auth/organization/list", {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(memberships.status).toBe(403);
      const another = await requestCode();
      const approving = await api.request("/api/auth/device/approve", {
        method: "POST",
        headers: { ...bearer, origin: baseUrl },
        body: JSON.stringify({ userCode: another.user_code }),
      });
      expect(approving.status).toBe(403);
    });

    test("renews a token's session without handing it a cookie", async () => {
      const { device_code, user_code } = await requestCode();
      await approve(user_code);
      const { access_token } = (await (await token(device_code)).json()) as {
        access_token: string;
      };
      // Due for renewal, as after a day in use.
      const due = new Date(Date.now() + 60 * 60 * 1000);
      await database.update(session).set({ expiresAt: due }).where(eq(session.token, access_token));
      const bearer = { authorization: `Bearer ${access_token}` };

      const found = await api.request("/api/auth/get-session", { headers: bearer });
      const listed = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: bearer,
      });

      expect([found.status, listed.status]).toEqual([200, 200]);
      expect(found.headers.getSetCookie()).toEqual([]);
      expect(found.headers.get("set-auth-token")).toBeNull();
      expect(listed.headers.getSetCookie()).toEqual([]);
      const [renewed] = await database
        .select({ expiresAt: session.expiresAt })
        .from(session)
        .where(eq(session.token, access_token));
      expect(renewed!.expiresAt.getTime()).toBeGreaterThan(due.getTime());
    });

    test("signs its own session out, and only that one", async () => {
      // `braivo logout`: without it, a token left on a shared machine stays
      // good until it expires.
      const { device_code, user_code } = await requestCode();
      await approve(user_code);
      const { access_token } = (await (await token(device_code)).json()) as {
        access_token: string;
      };
      const bearer = { authorization: `Bearer ${access_token}` };

      const signedOut = await api.request("/api/auth/sign-out", {
        method: "POST",
        headers: bearer,
      });
      const again = await api.request("/api/auth/sign-out", { method: "POST", headers: bearer });
      const sources = `/api/organizations/${organizationId}/sources`;

      expect([signedOut.status, again.status]).toEqual([200, 200]);
      expect((await api.request(sources, { headers: bearer })).status).toBe(401);
      expect((await api.request(sources, { headers: { cookie: teacher.cookie } })).status).toBe(
        200,
      );
    });

    test("carries the approver's roles, not more", async () => {
      // A learner can approve a code for themselves, and the token is a learner.
      const { device_code, user_code } = await requestCode();
      await approve(user_code, learner.cookie);
      const { access_token } = (await (await token(device_code)).json()) as {
        access_token: string;
      };

      const refused = await api.request(`/api/organizations/${organizationId}/sources`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Snuck in", text: "Hola." }),
      });

      expect(refused.status).toBe(403);
    });

    test("refuses a client Braivo does not know, and a token nobody issued", async () => {
      const unknown = await asCli("/api/auth/device/code", { client_id: "some-other-app" });
      const forged = await api.request(`/api/organizations/${organizationId}/sources`, {
        headers: { authorization: "Bearer not-a-session" },
      });

      expect(unknown.status).toBe(400);
      expect(forged.status).toBe(401);
    });
  });
});
