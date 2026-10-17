// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A remote MCP client signs in through Braivo's OAuth (code, PKCE, resource
// indicator), the person choosing one organization they manage, and calls
// Braivo's tools at `/mcp` as that person, in that organization alone (ADR 0045).

import { runMigrations } from "@braivo/db";
import { group, groupMember, member, oauthConsent, oauthRefreshToken } from "@braivo/db/schema";
import * as testing from "@braivo/db/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { registerOAuthClient, removeOAuthClient } from "../auth/oauth-client.ts";
import { setReviewerPassword } from "../auth/reviewer.ts";
import { createCourse, createObjectives } from "../persistence/index.ts";
import { createClient } from "./client.ts";
import { createConnectionClient, createConnectionRequest } from "./principal.ts";
import { baseUrl, connectionString, createTestApi, type Signed } from "./testing.ts";

// No metadata document is reachable in tests: each fetch is recorded, by the
// transport asked, and fails.
const metadata = vi.hoisted(() => ({ fetched: [] as string[] }));
vi.mock("../auth/client-metadata.ts", () => {
  const recording = (transport: string) => async () => {
    metadata.fetched.push(transport);
    throw new TypeError("no metadata document in tests");
  };
  return { fetchPinned: recording("pinned"), fetchStrictlyPublic: recording("strictly public") };
});

/** An app directory's reviewer, who signs in with a password (ADR 0018). */
const reviewerEmail = `mcp-test-reviewer-${crypto.randomUUID()}@example.com`;
const { database, auth, api, signUp, signUpAs } = createTestApi({
  reviewerEmails: new Set([reviewerEmail]),
});

const organizationId = "mcp-test-org";
/** A second organization the teacher manages, which an A-bound connection never reaches. */
const otherOrganizationId = "mcp-test-other-org";
/** One the reviewer manages. */
const reviewedOrganizationId = "mcp-test-reviewed-org";
/** One the teacher only learns in, which they cannot grant. */
const learningOrganizationId = "mcp-test-learning-org";
const redirectUri = "https://client.example/callback";
const resource = `${baseUrl}/mcp`;

let teacher!: Signed;
let clientId!: string;
/** A course of `organizationId`, and a course and a source of `otherOrganizationId`. */
let courseId!: string;
let otherCourseId!: string;
let otherSourceId!: string;

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

type Tokens = { access_token: string; refresh_token?: string; id_token?: string };

/** A JSON request to Better Auth from `person`'s browser on the console. */
const fromBrowser = (person: Signed, path: string, body: unknown) =>
  api.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: person.cookie, origin: baseUrl },
    body: JSON.stringify(body),
  });

/**
 * The signed query Better Auth sent the browser to `at` with, as the
 * console's `/consent` reads it, checking `/api/oauth/*` named the `step`.
 */
async function signedQuery(at: URL, step: "organization" | undefined): Promise<string> {
  const handedOver = await api.request(at);
  const page = new URL(handedOver.headers.get("location")!, baseUrl);
  expect(page.pathname).toBe("/consent");
  expect(page.searchParams.get("step") ?? undefined).toBe(step);
  return Buffer.from(page.searchParams.get("request")!.slice(2), "base64url").toString();
}

/**
 * Where a client's authorization request comes back to once `person` chooses
 * `organization` and approves or denies it. `signedOut` sends it without
 * their session, as a browser not yet signed in would; signing in on the way
 * is the console's, not tested here. `scope` is what the client asks for.
 */
async function authorize(
  person: Signed,
  {
    signedOut = false,
    accept = true,
    client = clientId,
    organization = organizationId,
    scope = "openid offline_access braivo:author",
  } = {},
) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const request = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
  request.search = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirectUri,
    // `offline_access` for a refresh token, as a connector keeps working with.
    scope,
    // A state the console's router would reparse as JSON, were it to read it.
    state: "1e3",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();

  const asked = await api.request(request, {
    headers: signedOut ? {} : { cookie: person.cookie },
  });
  // Every authorization first asks which organization, signed in or not.
  const choosing = new URL(asked.headers.get("location")!, baseUrl);
  expect(choosing.pathname).toBe("/api/oauth/organization");
  const chooseQuery = await signedQuery(choosing, "organization");
  expect(
    (await fromBrowser(person, "/organization/set-active", { organizationId: organization }))
      .status,
  ).toBe(200);
  const continued = await fromBrowser(person, "/oauth2/continue", {
    postLogin: true,
    oauth_query: chooseQuery,
    organizationId: organization,
  });
  expect(continued.status).toBe(200);
  // A consent already given for that organization is reused: straight back with a code.
  let answered = new URL(((await continued.json()) as { url: string }).url, baseUrl);
  if (answered.pathname === "/api/oauth/consent") {
    const decided = await fromBrowser(person, "/oauth2/consent", {
      accept,
      oauth_query: await signedQuery(answered, undefined),
      organizationId: organization,
    });
    answered = new URL(((await decided.json()) as { url: string }).url);
  }
  expect(`${answered.origin}${answered.pathname}`).toBe(redirectUri);
  return { answered, verifier };
}

/** The token request a client makes with the code it was sent back. */
const exchange = (code: string, verifier: string, client = clientId) =>
  api.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client,
      code_verifier: verifier,
      resource,
    }).toString(),
  });

/** The token request a client keeps working with. */
const refresh = (refreshToken: string, client = clientId) =>
  api.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client,
      resource,
    }).toString(),
  });

/** The tokens a client ends with once `person` approves it: an access token for `/mcp`. */
async function tokensFor(
  person: Signed,
  options: { signedOut?: boolean; client?: string; organization?: string; scope?: string } = {},
): Promise<Tokens> {
  const { answered, verifier } = await authorize(person, options);
  const token = await exchange(answered.searchParams.get("code")!, verifier, options.client);
  expect(token.status).toBe(200);
  return (await token.json()) as Tokens;
}

/** An MCP client on `/mcp`, its requests served in-process; `headers` as a browser would add. */
async function connect(accessToken: string, headers: Record<string, string> = {}): Promise<Client> {
  // The SDK's client negotiates an older revision by default; `/mcp` takes 2026-07-28 alone.
  const client = new Client(
    { name: "mcp-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}`, ...headers } },
      fetch: async (input, init) => api.request(input, init),
    }),
  );
  return client;
}

/** A tool's text answer, failing the test on an error, which would say why. */
async function text(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as [{ type: "text"; text: string }];
  if (result.isError) throw new Error(content.text);
  return content.text;
}

/** `/mcp`'s answer to one bare `tools/list`: for a refusal, which comes before the protocol's checks. */
const listTools = (accessToken: string) =>
  api.request(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

/** Braivo's API client in `person`'s browser on the console. */
const inConsole = (person: Signed) =>
  createClient({
    fetch: ((path: string, init?: RequestInit) =>
      api.request(path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          cookie: person.cookie,
          origin: baseUrl,
        },
      })) as typeof globalThis.fetch,
  });

/** `person`'s connection to `client` in `organization`, as the console lists it. */
async function connectionOf(person: Signed, client: string, organization: string) {
  const connection = (await inConsole(person).listConnections()).find(
    (listed) => listed.client.id === client && listed.organization.id === organization,
  );
  expect(connection).toBeDefined();
  return connection!;
}

/** Disconnecting in the console, as `person` would. */
async function disconnect(client: string, organization: string, person = teacher) {
  const { id } = await connectionOf(person, client, organization);
  await inConsole(person).disconnectConnection(id);
}

describe.skipIf(!connectionString)("remote MCP", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    const at = new Date("2026-06-01T00:00:00.000Z");
    for (const id of [organizationId, otherOrganizationId]) {
      await testing.seedOrganization(database, {
        organizationId: id,
        learnerIds: [],
        adminIds: [teacher.id],
        at,
      });
    }
    await testing.seedOrganization(database, {
      organizationId: learningOrganizationId,
      learnerIds: [teacher.id],
      at,
    });
    const course = async (organization: string) =>
      createCourse(database, {
        published: true,
        organizationId: organization,
        title: "Greetings",
        objectiveIds: await createObjectives(database, organization, ["Greet someone"]),
      });
    courseId = await course(organizationId);
    otherCourseId = await course(otherOrganizationId);
    // As the teacher's own tools would, in the console's organization.
    const asTeacher = createClient({
      fetch: ((path: string, init?: RequestInit) =>
        api.request(path, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            authorization: `Bearer ${teacher.token}`,
          },
        })) as typeof globalThis.fetch,
    });
    otherSourceId = await asTeacher.addSource({
      organizationId: otherOrganizationId,
      title: "Greetings",
      text: "Hola means hello.",
    });
    // As the operator's command does: the one way in where CIMD is off.
    ({ clientId } = await registerOAuthClient(auth, {
      name: "MCP test client",
      redirectUris: [redirectUri],
    }));
  });

  test("approves a request begun without a session", async () => {
    const client = await connect((await tokensFor(teacher, { signedOut: true })).access_token);

    const listed = await client.callTool({ name: "list_organizations", arguments: {} });

    expect(listed.isError).toBeFalsy();
    await client.close();
  });

  test("approves a request signed in with a reviewer's password, as with a code", async () => {
    const { id, email, name } = await signUpAs(reviewerEmail, "Reviewer");
    await testing.seedOrganization(database, {
      organizationId: reviewedOrganizationId,
      learnerIds: [],
      adminIds: [id],
      at: new Date("2026-06-01T00:00:00.000Z"),
    });
    const password = "a reviewer's password, long enough";
    await setReviewerPassword(auth, { email, password });
    const signedIn = await api.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email, password }),
    });
    expect(signedIn.status).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    const cookie = signedIn.headers
      .getSetCookie()
      .map((set) => set.split(";", 1)[0])
      .join("; ");
    const reviewer: Signed = { id, email, name, cookie, token };

    const client = await connect(
      (await tokensFor(reviewer, { signedOut: true, organization: reviewedOrganizationId }))
        .access_token,
    );

    const organizations = JSON.parse(await text(client, "list_organizations")) as { id: string }[];
    expect(organizations.map((organization) => organization.id)).toEqual([reviewedOrganizationId]);
    await client.close();
  });

  test("a denied request sends the client back refused, with no code", async () => {
    // A client yet to be consented to, so the page is not skipped.
    const { clientId: unconsented } = await registerOAuthClient(auth, {
      name: "Denied",
      redirectUris: [redirectUri],
    });
    const { answered } = await authorize(teacher, { accept: false, client: unconsented });

    expect(answered.searchParams.get("error")).toBe("access_denied");
    expect(answered.searchParams.has("code")).toBe(false);
  });

  test("cancelling before choosing an organization sends the client back refused", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Cancelled",
      redirectUris: [redirectUri],
    });
    // Managing none, so the console offers only Cancel.
    const person = await signUp();
    const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    asking.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirectUri,
      scope: "braivo:author",
      state: "cancelled",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource,
    }).toString();
    const asked = await api.request(asking, { headers: { cookie: person.cookie } });
    const query = await signedQuery(
      new URL(asked.headers.get("location")!, baseUrl),
      "organization",
    );

    // As the console sends it: no organization.
    const cancelled = await fromBrowser(person, "/oauth2/consent", {
      accept: false,
      oauth_query: query,
    });

    expect(cancelled.status).toBe(200);
    const answered = new URL(((await cancelled.json()) as { url: string }).url);
    expect(`${answered.origin}${answered.pathname}`).toBe(redirectUri);
    expect(answered.searchParams.get("error")).toBe("access_denied");
    expect(answered.searchParams.get("state")).toBe("cancelled");
    expect(answered.searchParams.has("code")).toBe(false);
    const granted = await database
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.clientId, client), eq(oauthConsent.userId, person.id)));
    expect(granted).toEqual([]);
  });

  test("a code is exchanged only with the verifier its challenge was made from", async () => {
    const { answered } = await authorize(teacher);

    const exchanged = await exchange(
      answered.searchParams.get("code")!,
      base64url(new Uint8Array(32)),
    );

    // Only the refusal: Better Auth's is 401 `invalid_request`, not RFC 6749's `invalid_grant`.
    expect(exchanged.ok).toBe(false);
    expect(await exchanged.json()).not.toHaveProperty("access_token");
  });

  test("`/mcp` takes access tokens alone, not other JWTs the same keys sign", async () => {
    const { id_token } = await tokensFor(teacher);
    // Right in all but its type, so only the `at+jwt` check refuses it.
    const { token: untyped } = await auth.api.signJWT({
      body: { payload: { iss: `${baseUrl}/api/auth`, aud: resource, sub: teacher.id } },
    });
    const call = (token: string) =>
      api.request(resource, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    expect((await call(id_token!)).status).toBe(401);
    expect((await call(untyped)).status).toBe(401);
  });

  test("`/mcp` refuses a page elsewhere in a browser, its token valid or not", async () => {
    const { access_token } = await tokensFor(teacher);

    await expect(connect(access_token, { origin: "https://evil.example" })).rejects.toThrow("403");
    // The console's own origin is no page elsewhere.
    await (await connect(access_token, { origin: baseUrl })).close();
  });

  test("names a client to the consent page only for a request Braivo signed", async () => {
    // Signed out, so Better Auth sends a signed request to sign in with.
    const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    asking.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "verify",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource,
    }).toString();
    const asked = await api.request(asking);
    const signed = new URL(asked.headers.get("location")!, baseUrl).search.slice(1);
    const named = (oauthQuery: string, client = clientId) =>
      api.request("/api/auth/oauth2/public-client-prelogin", {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ client_id: client, oauth_query: oauthQuery }),
      });

    expect((await named(signed)).status).toBe(200);
    // Another client's details, by a request signed for this one.
    expect((await named(signed, "another-client")).status).toBe(400);
    const forged = await named(signed.replace("state=verify", "state=forged"));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "invalid_signature" });
  });

  test("a client keeps working by refreshing its token, still only for `/mcp`", async () => {
    const { refresh_token } = await tokensFor(teacher);
    expect(refresh_token).toBeTruthy();

    const refreshed = await refresh(refresh_token!);
    expect(refreshed.status).toBe(200);
    const tokens = (await refreshed.json()) as Tokens;
    // Rotated; a retry with the old one within 30 s gets this same answer
    // (`mcp()`'s `refreshTokenReuseInterval`), for a client that lost the reply.
    expect(tokens.refresh_token).not.toBe(refresh_token);
    // `openid` adds Better Auth's userinfo as a second audience, yet the token
    // opens neither it nor Braivo's API, which takes a session's bearer alone.
    expect(decodeJwt(tokens.access_token).aud).toEqual([
      resource,
      `${baseUrl}/api/auth/oauth2/userinfo`,
    ]);
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    expect((await api.request("/api/auth/oauth2/userinfo", { headers: bearer })).status).toBe(403);
    expect((await api.request("/api/organizations", { headers: bearer })).status).toBe(401);

    const client = await connect(tokens.access_token);
    const listed = await client.callTool({ name: "list_organizations", arguments: {} });
    expect(listed.isError).toBeFalsy();
    await client.close();
  });

  test("lets no account register or manage a client", async () => {
    const asTeacher = {
      cookie: teacher.cookie,
      origin: baseUrl,
      "content-type": "application/json",
    };
    const paths = [
      ["POST", "register"],
      ["POST", "create-client"],
      ["GET", "get-client"],
      ["GET", "get-clients"],
      ["POST", "update-client"],
      ["POST", "delete-client"],
      ["POST", "client/rotate-secret"],
    ];

    for (const [method, path] of paths) {
      const response = await api.request(`/api/auth/oauth2/${path}`, {
        method,
        headers: asTeacher,
        body:
          method === "POST"
            ? JSON.stringify({
                client_id: clientId,
                redirect_uris: ["https://phish.example/callback"],
                client_name: "Braivo",
              })
            : undefined,
      });
      expect([path, response.status]).toEqual([path, 404]);
    }
    // Nor anyone signed out, though the metadata offers `none` by the flag
    // that would let them (`auth.ts`).
    const unsigned = await api.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://phish.example/callback"] }),
    });
    expect(unsigned.status).toBe(404);
  });

  test("removing a client refuses its refresh tokens", async () => {
    const { clientId: removed } = await registerOAuthClient(auth, {
      name: "Removed",
      redirectUris: [redirectUri],
    });
    const { access_token, refresh_token } = await tokensFor(teacher, { client: removed });
    expect(refresh_token).toBeTruthy();

    expect(await removeOAuthClient(auth, removed)).toBe(true);

    // Its consents go with it, so its access tokens open nothing either.
    expect((await listTools(access_token)).status).toBe(401);
    const refused = await refresh(refresh_token!, removed);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
    expect(await removeOAuthClient(auth, removed)).toBe(false);
  });

  test("registers only redirect URIs Better Auth accepts, a loopback's port free", async () => {
    const register = (uri: string) =>
      registerOAuthClient(auth, { name: "Refused", redirectUris: [uri] });

    const refused = "https:// off the loopback";
    await expect(register("http://client.example/callback")).rejects.toThrow(refused);
    await expect(register("https://localhost/callback")).rejects.toThrow(refused);
    // Loopback still, however written: Better Auth refuses each.
    await expect(register("https://localhost./callback")).rejects.toThrow(refused);
    await expect(register("https://127.0.0.2/callback")).rejects.toThrow(refused);
    await expect(register("http://127.1/callback")).rejects.toThrow(refused);
    await expect(register("https://2130706433/callback")).rejects.toThrow(refused);
    // Parsed as `https://client.example/callback`, never sent as written.
    await expect(register("https:client.example/callback")).rejects.toThrow(refused);
    const named = (name: string, id?: string) =>
      registerOAuthClient(auth, { name, redirectUris: [redirectUri], clientId: id });
    await expect(named(" ")).rejects.toThrow("name");
    await expect(named("Blank", "")).rejects.toThrow("blank");
    await expect(named("Padded", " https://client.example/id")).rejects.toThrow("spaces");
    await expect(register("https://client.example/callback#x")).rejects.toThrow("fragment");
    await expect(register("http://localhost:80\\@evil.example/callback")).rejects.toThrow(
      "backslash",
    );
    // Parsed without the tab, so a client sending the parsed URI would never match.
    await expect(register("https://client.example/ca\tllback")).rejects.toThrow("whitespace");
    await expect(register("callback")).rejects.toThrow("absolute");
    await expect(
      registerOAuthClient(auth, { name: "Taken", redirectUris: [redirectUri], clientId }),
    ).rejects.toThrow("already registered");

    // Registered portless, asked for on whichever port the client listens on.
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const { clientId: local } = await registerOAuthClient(auth, {
        name: "On the loopback",
        redirectUris: [`http://${host}/callback`],
      });
      const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
      asking.search = new URLSearchParams({
        response_type: "code",
        client_id: local,
        redirect_uri: `http://${host}:53682/callback`,
        state: "loopback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource,
      }).toString();
      const asked = await api.request(asking, { headers: { cookie: teacher.cookie } });
      expect([host, new URL(asked.headers.get("location")!, baseUrl).pathname]).toEqual([
        host,
        "/api/oauth/organization",
      ]);
    }
  });

  test("serves the tools learners never see, in the organization chosen alone", async () => {
    const client = await connect((await tokensFor(teacher)).access_token);

    const { tools } = await client.listTools();
    const organizations = JSON.parse(await text(client, "list_organizations")) as { id: string }[];
    await client.close();

    // No task writing, group, or progress: task-writing tools join once a
    // tool's correction can wait and answers say what waits (ADR 0039).
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "add_document",
      "add_source",
      "add_transcript",
      "cite_sources",
      "create_course",
      "define_objectives",
      "list_courses",
      "list_objectives",
      "list_organizations",
      "list_sources",
      "list_tasks",
      "read_course",
      "read_source",
    ]);
    // The teacher manages two; the grant is for one.
    expect(organizations.map(({ id }) => id)).toEqual([organizationId]);
  });

  test("refuses another organization the person manages, named or by its resources", async () => {
    const client = await connect((await tokensFor(teacher)).access_token);
    const refused = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return result.isError === true;
    };

    expect(await refused("list_sources", { organizationId })).toBe(false);
    expect(await refused("list_sources", { organizationId: otherOrganizationId })).toBe(true);
    expect(
      await refused("read_course", {
        organizationId: otherOrganizationId,
        courseId: otherCourseId,
      }),
    ).toBe(true);
    // Its own organization beside another's course or source.
    expect(await refused("read_course", { organizationId, courseId: otherCourseId })).toBe(true);
    expect(await refused("read_source", { organizationId, sourceId: otherSourceId })).toBe(true);
    await client.close();

    // Routes no tool here calls: a course by its ID alone, its own
    // organization's included, and what braivo:author does not grant.
    const principal = { userId: teacher.id, clientId, scopes: ["braivo:author"], organizationId };
    const asConnection = createConnectionClient({ api, baseUrl, principal });
    await expect(asConnection.listSources(organizationId)).resolves.toBeTruthy();
    for (const refusedCall of [
      () => asConnection.courseProgress(courseId),
      () => asConnection.courseProgress(otherCourseId),
      () => asConnection.listGroups(organizationId),
      () => asConnection.listMembers(organizationId),
    ]) {
      await expect(refusedCall()).rejects.toMatchObject({ status: 403 });
    }
  });

  test("lists and reaches nothing once its person no longer administers, though they teach there", async () => {
    const demoted = await signUp();
    await database.insert(member).values({
      id: `${demoted.id}-admin`,
      organizationId,
      userId: demoted.id,
      role: "admin",
      createdAt: new Date(),
    });
    const groupId = `${demoted.id}-group`;
    await database
      .insert(group)
      .values({ id: groupId, organizationId, name: "Taught", creationDigest: "-" });
    await database
      .insert(groupMember)
      .values({ organizationId, groupId, userId: demoted.id, role: "teacher" });
    const client = await connect((await tokensFor(demoted)).access_token);

    await database
      .update(member)
      .set({ role: "member" })
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, demoted.id)));

    expect(JSON.parse(await text(client, "list_organizations"))).toEqual([]);
    for (const [name, args] of [
      ["list_sources", { organizationId }],
      ["read_course", { organizationId, courseId }],
    ] as const) {
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    await client.close();
  });

  test("holds a course a connection creates from learners, and refuses its publishing", async () => {
    const learner = await signUp();
    await database.insert(member).values({
      id: `${learner.id}-member`,
      organizationId,
      userId: learner.id,
      role: "member",
      createdAt: new Date(),
    });
    const [objectiveId] = await createObjectives(database, organizationId, ["Say goodbye"]);
    const listed = async () =>
      (
        (await (
          await api.request("/api/courses", { headers: { cookie: learner.cookie } })
        ).json()) as { courses: { id: string }[] }
      ).courses.map(({ id }) => id);

    const client = await connect((await tokensFor(teacher)).access_token);
    const { courseId: proposed } = JSON.parse(
      await text(client, "create_course", {
        organizationId,
        title: "Proposed",
        objectiveIds: [objectiveId],
        key: `proposed-${crypto.randomUUID()}`,
      }),
    ) as { courseId: string };
    await client.close();

    // A connection sends no Authorization header to the API, yet is a tool.
    expect(await listed()).not.toContain(proposed);
    const principal = { userId: teacher.id, clientId, scopes: ["braivo:author"], organizationId };
    const asConnection = createConnectionClient({ api, baseUrl, principal });
    await expect(
      asConnection.publish({ organizationId, courseIds: [proposed] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await listed()).not.toContain(proposed);

    // A person publishes it in the console; then learners reach it.
    await inConsole(teacher).publish({ organizationId, courseIds: [proposed] });
    expect(await listed()).toContain(proposed);
  });

  test("refuses a token without braivo:author before any tool runs, naming that scope", async () => {
    const { access_token } = await tokensFor(teacher, { scope: "openid offline_access" });

    const response = await listTools(access_token);

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope", scope="braivo:author"',
    );
  });

  test("refuses a disconnected grant's next call while its token still verifies", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Disconnected",
      redirectUris: [redirectUri],
    });
    const { access_token } = await tokensFor(teacher, { client });
    await (await connect(access_token)).close();

    await disconnect(client, organizationId);

    const refused = await listTools(access_token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const keys = createLocalJWKSet(await auth.api.getJwks());
    await expect(jwtVerify(access_token, keys, { audience: resource })).resolves.toBeTruthy();
  });

  test("refuses a disconnected grant's refresh tokens, every one, and no other grant's", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Refreshing",
      redirectUris: [redirectUri],
    });
    // Authorized twice for A, so two refresh tokens hold the one grant.
    const first = await tokensFor(teacher, { client });
    const again = await tokensFor(teacher, { client });
    const otherSchool = await tokensFor(teacher, { client, organization: otherOrganizationId });
    // A colleague's grant to the same app for the same organization.
    const colleague = await signUp();
    await database.insert(member).values({
      id: `${colleague.id}-admin`,
      organizationId,
      userId: colleague.id,
      role: "admin",
      createdAt: new Date(),
    });
    const theirs = await tokensFor(colleague, { client });

    await disconnect(client, organizationId);

    for (const { refresh_token } of [first, again]) {
      const refused = await refresh(refresh_token!, client);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("invalid_grant");
    }
    for (const kept of [otherSchool, theirs]) {
      const refreshed = await refresh(kept.refresh_token!, client);
      expect(refreshed.status).toBe(200);
      const { access_token } = (await refreshed.json()) as Tokens;
      await (await connect(access_token)).close();
      await (await connect(kept.access_token)).close();
    }
    const listed = (await inConsole(teacher).listConnections()).filter(
      (connection) => connection.client.id === client,
    );
    expect(listed.map((connection) => connection.organization.id)).toEqual([otherOrganizationId]);
  });

  /**
   * `person`'s refresh token rows for `client`: put back after a disconnect,
   * as a rotation inserting its successor just after one would leave them.
   */
  const refreshRows = (client: string, person = teacher) =>
    database
      .select()
      .from(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.clientId, client), eq(oauthRefreshToken.userId, person.id)));

  test("refuses a disconnected grant's refresh token though its row survived", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Surviving",
      redirectUris: [redirectUri],
    });
    const { refresh_token } = await tokensFor(teacher, { client });
    const rows = await refreshRows(client);

    await disconnect(client, organizationId);
    await database.insert(oauthRefreshToken).values(rows);

    const refused = await refresh(refresh_token!, client);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("refuses a disconnected grant's refresh token however the form is written", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Written oddly",
      redirectUris: [redirectUri],
    });
    const kept = await tokensFor(teacher, { client, organization: otherOrganizationId });
    const { refresh_token } = await tokensFor(teacher, { client });
    const rows = (await refreshRows(client)).filter((row) => row.referenceId === organizationId);
    await disconnect(client, organizationId);
    await database.insert(oauthRefreshToken).values(rows);
    const token = (body: string, contentType = "application/x-www-form-urlencoded") =>
      api.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    const fields = (grant: string) =>
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(grant)}&client_id=${encodeURIComponent(client)}&resource=${encodeURIComponent(resource)}`;

    // A JSON string is a form too: one Better Auth reads as its fields.
    const asJsonString = await token(JSON.stringify(`x&${fields(refresh_token!)}&y=`));
    // Better Auth trims the grant type.
    const padded = await token(
      fields(refresh_token!).replace("=refresh_token", "=%20refresh_token"),
    );
    const asJson = await token(
      JSON.stringify({ grant_type: "refresh_token", refresh_token, client_id: client, resource }),
      "application/x-www-form-urlencoded+json",
    );
    // A field sent twice, which OAuth forbids (RFC 6749, 3.2): either may be the one read.
    const twice = await token(`${fields(refresh_token!)}&refresh_token=${kept.refresh_token}`);
    const twiceTheOtherWay = await token(
      `${fields(kept.refresh_token!)}&refresh_token=${refresh_token}`,
    );

    for (const refused of [asJsonString, padded, asJson]) expect(refused.status).toBe(400);
    for (const refused of [twice, twiceTheOtherWay]) {
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    }
    expect((await token(fields(kept.refresh_token!))).status).toBe(200);
  });

  test("refuses a refresh token from before a disconnect, once the grant is given again", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Surviving, reconnected",
      redirectUris: [redirectUri],
    });
    const before = await tokensFor(teacher, { client });
    const rows = await refreshRows(client);
    await disconnect(client, organizationId);
    await database.insert(oauthRefreshToken).values(rows);
    // Into the next second: both are counted in whole seconds.
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 10));

    const after = await tokensFor(teacher, { client });

    const refused = await refresh(before.refresh_token!, client);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await refresh(after.refresh_token!, client)).status).toBe(200);
  });

  test("lets only the person's browser disconnect, never a token, a connection, or someone else", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Kept",
      redirectUris: [redirectUri],
    });
    const { access_token } = await tokensFor(teacher, { client });
    const { id } = await connectionOf(teacher, client, organizationId);
    const path = `/api/connections/${encodeURIComponent(id)}/disconnect`;
    const write = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    const principal = {
      userId: teacher.id,
      clientId: client,
      scopes: ["braivo:author"],
      organizationId,
    };

    const byToken = await api.request(path, {
      ...write,
      headers: { ...write.headers, authorization: `Bearer ${teacher.token}` },
    });
    const byConnection = await api.fetch(
      createConnectionRequest(principal, `${baseUrl}${path}`, write),
    );
    const listedByToken = await api.request("/api/connections", {
      headers: { authorization: `Bearer ${teacher.token}` },
    });
    const listedByConnection = await api.fetch(
      createConnectionRequest(principal, `${baseUrl}/api/connections`),
    );
    const someoneElse = await signUp();
    const bySomeoneElse = inConsole(someoneElse).disconnectConnection(id);

    expect([byToken.status, byConnection.status]).toEqual([403, 403]);
    expect([listedByToken.status, listedByConnection.status]).toEqual([403, 403]);
    await expect(bySomeoneElse).rejects.toMatchObject({ status: 404 });
    expect(await inConsole(someoneElse).listConnections()).toEqual([]);
    await (await connect(access_token)).close();
  });

  test("refuses a token from before a disconnect, once the grant is given again", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Reconnected",
      redirectUris: [redirectUri],
    });
    const before = await tokensFor(teacher, { client });
    await disconnect(client, organizationId);
    // Into the next second: both are counted in whole seconds.
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 10));

    const after = await tokensFor(teacher, { client });

    expect((await listTools(before.access_token)).status).toBe(401);
    await (await connect(after.access_token)).close();
  });

  test("refuses an organization other than the one the page showed, chosen in another tab", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Two tabs",
      redirectUris: [redirectUri],
    });
    const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    asking.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirectUri,
      scope: "braivo:author",
      state: "tabs",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource,
    }).toString();
    const asked = await api.request(asking, { headers: { cookie: teacher.cookie } });
    const query = await signedQuery(
      new URL(asked.headers.get("location")!, baseUrl),
      "organization",
    );
    // The first tab chooses A, and reaches consent naming it.
    await fromBrowser(teacher, "/organization/set-active", { organizationId });
    const continued = await fromBrowser(teacher, "/oauth2/continue", {
      postLogin: true,
      oauth_query: query,
      organizationId,
    });
    const consenting = new URL(((await continued.json()) as { url: string }).url, baseUrl);
    const consentQuery = await signedQuery(consenting, undefined);
    // Another tab chooses B meanwhile.
    await fromBrowser(teacher, "/organization/set-active", {
      organizationId: otherOrganizationId,
    });

    const approved = await fromBrowser(teacher, "/oauth2/consent", {
      accept: true,
      oauth_query: consentQuery,
      organizationId,
    });
    const resumed = await fromBrowser(teacher, "/oauth2/continue", {
      postLogin: true,
      oauth_query: query,
      organizationId,
    });

    for (const refused of [approved, resumed]) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "ACTIVE_ORGANIZATION_CHANGED" });
    }
    const granted = await database
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.clientId, client), eq(oauthConsent.userId, teacher.id)));
    expect(granted).toEqual([]);
  });

  test("answers someone signed out meanwhile as signed out, not as another tab's choice", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Signed out",
      redirectUris: [redirectUri],
    });
    const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    asking.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirectUri,
      scope: "braivo:author",
      state: "signed-out",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource,
    }).toString();
    const asked = await api.request(asking, { headers: { cookie: teacher.cookie } });
    const query = await signedQuery(
      new URL(asked.headers.get("location")!, baseUrl),
      "organization",
    );
    const signedOut = { ...teacher, cookie: "" };

    for (const [path, body] of [
      ["/oauth2/continue", { postLogin: true, oauth_query: query, organizationId }],
      ["/oauth2/consent", { accept: true, oauth_query: query, organizationId }],
    ] as const) {
      expect((await fromBrowser(signedOut, path, body)).status).toBe(401);
    }
  });

  test("keeps a person's grants to one client for two organizations apart", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Two organizations",
      redirectUris: [redirectUri],
    });
    const first = await tokensFor(teacher, { client });
    const second = await tokensFor(teacher, { client, organization: otherOrganizationId });
    expect(decodeJwt(first.access_token).organization_id).toBe(organizationId);
    expect(decodeJwt(second.access_token).organization_id).toBe(otherOrganizationId);

    await disconnect(client, organizationId);

    expect((await listTools(first.access_token)).status).toBe(401);
    const other = await connect(second.access_token);
    const organizations = JSON.parse(await text(other, "list_organizations")) as { id: string }[];
    await other.close();
    expect(organizations.map(({ id }) => id)).toEqual([otherOrganizationId]);
  });

  test("lets no one grant an organization they only learn in", async () => {
    const { clientId: client } = await registerOAuthClient(auth, {
      name: "Learning",
      redirectUris: [redirectUri],
    });
    const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    asking.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirectUri,
      scope: "braivo:author",
      state: "learning",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource,
    }).toString();
    const asked = await api.request(asking, { headers: { cookie: teacher.cookie } });
    const query = await signedQuery(
      new URL(asked.headers.get("location")!, baseUrl),
      "organization",
    );
    await fromBrowser(teacher, "/organization/set-active", {
      organizationId: learningOrganizationId,
    });

    // Asked again to choose, rather than on to consent.
    const continued = await fromBrowser(teacher, "/oauth2/continue", {
      postLogin: true,
      oauth_query: query,
      organizationId: learningOrganizationId,
    });
    const next = new URL(((await continued.json()) as { url: string }).url, baseUrl);
    expect(next.pathname).toBe("/api/oauth/organization");
    // Nor consenting outright.
    const consented = await fromBrowser(teacher, "/oauth2/consent", {
      accept: true,
      oauth_query: query,
      organizationId: learningOrganizationId,
    });
    expect(consented.status).toBe(403);
    const granted = await database
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.clientId, client), eq(oauthConsent.userId, teacher.id)));
    expect(granted).toEqual([]);
  });

  describe("where client ID metadata documents are not fetched", () => {
    const withoutCimd = createTestApi({ clientIdMetadataDocuments: false });
    const urlClientId = "https://client.example/client.json";
    const authorizeAt = (on: typeof api, client: string) => {
      const asking = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
      asking.search = new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: redirectUri,
        state: "workers",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource,
      }).toString();
      return on.request(asking, { headers: { cookie: teacher.cookie } });
    };

    beforeEach(() => {
      metadata.fetched = [];
    });

    // What discovery advertises, and which transport fetches, is
    // `server.test.ts`'s, through `createServer`.

    test("an unregistered client named by URL is refused, its document never fetched", async () => {
      // The default API fetches it, so the none below means something.
      await authorizeAt(api, urlClientId);
      expect(metadata.fetched).toEqual(["pinned"]);
      metadata.fetched = [];

      const refused = await authorizeAt(withoutCimd.api, urlClientId);

      expect(refused.headers.get("location") ?? "").not.toContain(redirectUri);
      expect(
        new URL(refused.headers.get("location") ?? baseUrl, baseUrl).searchParams.get("error"),
      ).toBe("invalid_client");
      expect(metadata.fetched).toEqual([]);
    });

    test("a registered client with a URL for its ID reaches consent, nothing fetched", async () => {
      const { clientId: registered } = await registerOAuthClient(withoutCimd.auth, {
        name: "Registered by URL",
        redirectUris: [redirectUri],
        clientId: `https://registered.example/${crypto.randomUUID()}.json`,
      });

      const asked = await authorizeAt(withoutCimd.api, registered);

      expect(new URL(asked.headers.get("location")!, baseUrl).pathname).toBe(
        "/api/oauth/organization",
      );
      expect(metadata.fetched).toEqual([]);
    });
  });
});
