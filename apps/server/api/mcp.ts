// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createLocalJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import { isConnectionStanding } from "../application/index.ts";
import { type Auth, AUTHOR_SCOPE, ORGANIZATION_CLAIM } from "../auth/index.ts";
import { createMcpServer } from "../mcp/index.ts";
import { createConnectionClient, type Principal } from "./principal.ts";

/** No release is stamped into the server yet; `braivo mcp` says the same unbuilt. */
const VERSION = "development";

/**
 * `/mcp` for remote MCP clients, signed in through Braivo's OAuth (`mcp()` in
 * `auth.ts`; ADR 0045). MCP 2026-07-28 alone, stateless: one server per
 * request, its tools calling Braivo's API in this process as the connection
 * (`createConnectionClient`), so every rule is the API's.
 *
 * Tokens are checked here rather than by `requireMcpAuth`, which fetches this
 * server's own JWKS over HTTP: no listener in tests, and a Worker calling its
 * own hostname. The keys are read in-process instead.
 */
export function mcpEndpoint(options: {
  auth: Auth;
  database: Database;
  /** Where the catalog's calls go, in this process: the API serving `/mcp`. */
  api: { fetch: (request: Request) => Response | Promise<Response> };
  /** The installation's origin, which those calls are addressed to. */
  baseUrl: string;
  /** `/mcp`'s URL: the audience its tokens are issued for. */
  resource: string;
  /** Better Auth's issuer, `<BRAIVO_URL>/api/auth`. */
  issuer: string;
}) {
  const { auth, database, api, baseUrl, resource, issuer } = options;
  // RFC 9728, 5.1: where a client without a valid token learns how to get one,
  // and with which scope (RFC 6750, 3).
  const metadata = new URL(
    `/.well-known/oauth-protected-resource${new URL(resource).pathname}`,
    resource,
  ).href;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${AUTHOR_SCOPE}"`;

  /** The verified claims of an access token for `/mcp`, or none. */
  async function verify(request: Request): Promise<JWTPayload | undefined> {
    const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return undefined;
    try {
      const keys = createLocalJWKSet(await auth.api.getJwks());
      // An access token (RFC 9068), not an ID token or another JWT the same
      // keys sign; and one that expires.
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: resource,
        typ: "at+jwt",
        requiredClaims: ["exp"],
      });
      // A DPoP-bound token proves its sender, which a bearer cannot; and a
      // token for no one cannot act for anyone.
      return payload.cnf === undefined && typeof payload.sub === "string" && payload.sub
        ? payload
        : undefined;
    } catch (error) {
      // An invalid token; anything else, the keys unreadable, is a failure.
      if (error instanceof errors.JOSEError) return undefined;
      throw error;
    }
  }

  /**
   * Who a verified token acts for, while its grant stands: a token outlives
   * a disconnect by up to its hour, so the consent it was issued under is
   * looked up on every call, by person, client, organization, and when it
   * was given (ADR 0045).
   */
  async function principalOf(claims: JWTPayload): Promise<Principal | undefined> {
    const { sub: userId, client_id: clientId, scope, iat } = claims;
    const organizationId = claims[ORGANIZATION_CLAIM];
    if (typeof userId !== "string" || typeof clientId !== "string") return undefined;
    if (typeof organizationId !== "string" || !organizationId) return undefined;
    // Issued under this grant, not one disconnected before it was given again.
    if (typeof iat !== "number") return undefined;
    const issuedAt = new Date(iat * 1000);
    const granted = await isConnectionStanding(database, {
      userId,
      clientId,
      organizationId,
      issuedAt,
    });
    if (!granted) return undefined;
    const scopes = typeof scope === "string" ? scope.split(" ") : [];
    return { userId, clientId, scopes, organizationId };
  }

  // Without the tools reading about learners, until `braivo:progress` exists.
  const handler = createMcpHandler(
    ({ authInfo }) =>
      createMcpServer(
        createConnectionClient({
          api,
          baseUrl,
          principal: authInfo?.extra?.principal as Principal,
        }),
        VERSION,
        { consoleUrl: baseUrl, catalog: "authoring" },
      ),
    { legacy: "reject" },
  );

  return async (request: Request): Promise<Response> => {
    const claims = await verify(request);
    const principal = claims && (await principalOf(claims));
    if (!principal) {
      const presented = request.headers.has("authorization");
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": presented ? `${challenge}, error="invalid_token"` : challenge,
        },
      });
    }
    // Every tool served here authors (ADR 0045): refused before any runs,
    // naming the scope a client steps up to.
    if (!principal.scopes.includes(AUTHOR_SCOPE)) {
      return new Response(null, {
        status: 403,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${AUTHOR_SCOPE}"`,
        },
      });
    }
    return handler.fetch(request, {
      authInfo: {
        token: "",
        clientId: principal.clientId,
        scopes: [...principal.scopes],
        extra: { principal },
      },
    });
  };
}
