// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Spike (#113): a remote MCP client signs in through Braivo's OAuth (code,
// PKCE, resource indicator) and calls a tool at `/mcp` as the person who
// approved it.

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeJwt } from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { registerOAuthClient, removeOAuthClient } from "../auth/oauth-client.ts";
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

const { database, auth, api, signUp } = createTestApi();

const organizationId = "mcp-test-org";
const redirectUri = "https://client.example/callback";
const resource = `${baseUrl}/mcp`;

let teacher!: Signed;
let clientId!: string;

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

type Tokens = { access_token: string; refresh_token?: string; id_token?: string };

/**
 * Where a client's authorization request comes back to once `person` approves
 * or denies it. `signedOut` sends it without their session, as a browser not
 * yet signed in would; signing in on the way is the console's, not tested here.
 */
async function authorize(
  person: Signed,
  { signedOut = false, accept = true, client = clientId } = {},
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
    scope: "openid offline_access",
    // A state the console's router would reparse as JSON, were it to read it.
    state: "1e3",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();

  const asked = await api.request(request, {
    headers: signedOut ? {} : { cookie: person.cookie },
  });
  // A consent already given is reused: straight back with a code.
  let answered = new URL(asked.headers.get("location")!, baseUrl);
  if (answered.pathname === "/api/oauth/consent") {
    // On to the console's page, the signed request carried whole.
    const handedOver = await api.request(answered);
    const consent = new URL(handedOver.headers.get("location")!, baseUrl);
    expect(consent.pathname).toBe("/consent");
    const signed = consent.searchParams.get("request")!;
    const oauthQuery = Buffer.from(signed.slice(2), "base64url").toString();
    const decided = await api.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: person.cookie, origin: baseUrl },
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
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
  options: { signedOut?: boolean; client?: string } = {},
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

describe.skipIf(!connectionString)("remote MCP", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");
    teacher = await signUp();
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [teacher.id],
      at: new Date("2026-06-01T00:00:00.000Z"),
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

  test("a denied request sends the client back refused, with no code", async () => {
    // Someone yet to consent, so the page is not skipped.
    const { answered } = await authorize(await signUp(), { accept: false });

    expect(answered.searchParams.get("error")).toBe("access_denied");
    expect(answered.searchParams.has("code")).toBe(false);
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
    const { refresh_token } = await tokensFor(teacher, { client: removed });
    expect(refresh_token).toBeTruthy();

    expect(await removeOAuthClient(auth, removed)).toBe(true);

    // Its access tokens verify until they expire: `/mcp` does not yet check
    // the connection per call (ADR 0045).
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
        "/api/oauth/consent",
      ]);
    }
  });

  test("a client approved by a person lists the organizations that person manages", async () => {
    const listed = async (person: Signed) => {
      const client = await connect((await tokensFor(person)).access_token);
      const result = await client.callTool({ name: "list_organizations", arguments: {} });
      await client.close();
      expect(result.isError).toBeFalsy();
      const [content] = result.content as [{ type: "text"; text: string }];
      const { organizations } = JSON.parse(content.text) as { organizations: { id: string }[] };
      return organizations.map(({ id }) => id);
    };

    expect(await listed(teacher)).toEqual([organizationId]);
    // Someone managing none, through the same client: the token's person, not the client's.
    expect(await listed(await signUp())).toEqual([]);
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

      expect(new URL(asked.headers.get("location")!, baseUrl).pathname).toBe("/api/oauth/consent");
      expect(metadata.fetched).toEqual([]);
    });
  });
});
