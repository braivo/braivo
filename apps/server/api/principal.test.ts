// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A connection's principal on the API's routes (`principal.ts`): carried only
// by the request object `/mcp` built, and held to a token's limits.

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import {
  createConnectionClient,
  createConnectionRequest,
  type Principal,
  principalOf,
} from "./principal.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

const { database, api, signUp } = createTestApi();

const organizationId = "principal-test-org";

let teacher!: Signed;
/** Someone else, whose credentials a connection's request must never act as. */
let other!: Signed;
/** A device-flow token's holder, for what a token is refused; its sign-out ends it. */
let tool!: Signed;
let principal!: Principal;

const url = (path: string) => new URL(path, baseUrl).href;

/** Who `GET /api/organizations` answers for, by the organizations it lists. */
async function organizationIds(response: Response) {
  expect(response.status).toBe(200);
  const { organizations } = (await response.json()) as { organizations: { id: string }[] };
  return organizations.map((organization) => organization.id);
}

test("marks only the request it built", () => {
  const marked = createConnectionRequest(
    { userId: "u", clientId: "c", scopes: [], organizationId: "o" },
    url("/api"),
  );

  expect(principalOf(marked)?.userId).toBe("u");
  expect(principalOf(marked.clone() as Request)).toBeUndefined();
  expect(principalOf(new Request(marked))).toBeUndefined();
  expect(principalOf(new Request(url("/api"), { headers: marked.headers }))).toBeUndefined();
});

test("drops any other credential from the request it builds", () => {
  const marked = createConnectionRequest(
    { userId: "u", clientId: "c", scopes: [], organizationId: "o" },
    url("/api"),
    {
      headers: { cookie: "a=b", authorization: "Bearer t", "content-type": "application/json" },
    },
  );

  expect([...marked.headers.keys()]).toEqual(["content-type"]);
});

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("a connection on the API's routes", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    other = await signUp();
    tool = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [teacher.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    principal = {
      userId: teacher.id,
      clientId: "test-client",
      scopes: ["braivo:author"],
      organizationId,
    };
  });

  test("reads as the connection's user, and gets no cookie", async () => {
    const response = await api.fetch(createConnectionRequest(principal, url("/api/organizations")));

    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await organizationIds(response)).toContain(organizationId);
  });

  test("is no one when its request is cloned or rebuilt", async () => {
    const marked = createConnectionRequest(principal, url("/api/organizations"));

    expect((await api.fetch(marked.clone() as Request)).status).toBe(401);
    expect((await api.fetch(new Request(marked))).status).toBe(401);
  });

  test("is no one from outside, whatever the request says", async () => {
    const response = await api.request("/api/organizations", {
      headers: {
        "x-braivo-principal": JSON.stringify(principal),
        "x-user-id": teacher.id,
        authorization: `Connection ${teacher.id}`,
        forwarded: "for=127.0.0.1",
      },
    });

    expect(response.status).toBe(401);
  });

  // Added after marking, past `createConnectionRequest` dropping them: what
  // `sessionFor` itself decides.
  test("acts as its principal alone, whatever credential rides along", async () => {
    for (const [name, value] of [
      ["cookie", other.cookie],
      ["authorization", `Bearer ${other.token}`],
    ] as const) {
      const marked = createConnectionRequest(principal, url("/api/organizations"));
      marked.headers.set(name, value);

      expect(await organizationIds(await api.fetch(marked))).toContain(organizationId);
    }
    // And a person's own credential stays theirs: the teacher's organization
    // is not the other's.
    const own = await api.request("/api/organizations", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(await organizationIds(own)).not.toContain(organizationId);
  });

  // What a device-flow token is refused, a connection is; and Better Auth's
  // session endpoints a token may reach, since a connection has no session.
  test.each([
    ["approving a device", "POST", "/api/auth/device/approve", true],
    ["signing out", "POST", "/api/session/sign-out", true],
    ["handing off to a learn domain", "POST", "/api/handoffs/any", true],
    ["Better Auth's session", "GET", "/api/auth/get-session", false],
    ["Better Auth's sign-out", "POST", "/api/auth/sign-out", false],
  ])("is refused %s", async (_label, method, path, tokenRefused) => {
    const init = {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    };
    const asToken = await api.request(path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${tool.token}` },
    });
    const asConnection = await api.fetch(createConnectionRequest(principal, url(path), init));

    expect(asToken.status === 403).toBe(tokenRefused);
    expect(asConnection.status).toBe(403);
    expect(asConnection.headers.has("set-cookie")).toBe(false);
  });

  test("is not a learner, even beside its person's cookie", async () => {
    const marked = createConnectionRequest(principal, url("/api/session"));
    marked.headers.set("cookie", teacher.cookie);

    const response = await api.fetch(marked);

    expect(response.status).toBe(401);
  });

  test("carries its principal past a body limit that replaces the request", async () => {
    const title = `Greet ${crypto.randomUUID().slice(0, 8)}`;
    // A stream, so no `Content-Length`: `limitBody` reads it and rebuilds the request.
    const body = new Blob([JSON.stringify({ objectives: [{ title }] })]).stream();
    const request = createConnectionRequest(
      principal,
      url(`/api/organizations/${organizationId}/objectives`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit,
    );
    expect(request.headers.has("content-length")).toBe(false);

    const response = await api.fetch(request);

    expect(response.status).toBe(201);
  });

  test("serves Braivo's API client in-process", async () => {
    const client = createConnectionClient({ api, baseUrl, principal });

    const organizations = await client.listOrganizations();

    expect(organizations.map((organization) => organization.id)).toContain(organizationId);
  });
});
