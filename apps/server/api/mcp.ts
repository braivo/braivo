// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@braivo/db";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createLocalJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import { listManagedOrganizations } from "../application/index.ts";
import type { Auth } from "../auth/index.ts";

/**
 * Spike (#113): `/mcp` for remote MCP clients, signed in through Braivo's OAuth
 * (`mcp()` in `auth.ts`). MCP 2026-07-28 alone, stateless: one server per
 * request, for the person the verified token names.
 *
 * Tokens are checked here rather than by `requireMcpAuth`, which fetches this
 * server's own JWKS over HTTP: no listener in tests, and a Worker calling its
 * own hostname. The keys are read in-process instead.
 */
export function mcpEndpoint(options: {
  auth: Auth;
  database: Database;
  /** `/mcp`'s URL: the audience its tokens are issued for. */
  resource: string;
  /** Better Auth's issuer, `<BRAIVO_URL>/api/auth`. */
  issuer: string;
}) {
  const { auth, database, resource, issuer } = options;
  // RFC 9728, 5.1: where a client without a valid token learns how to get one.
  const challenge = `Bearer resource_metadata="${new URL(`/.well-known/oauth-protected-resource${new URL(resource).pathname}`, resource).href}"`;

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
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const userId = String(authInfo?.extra?.userId);
      const server = new McpServer({ name: "braivo", version: "0.0.0" });
      server.registerTool(
        "list_organizations",
        {
          title: "List organizations",
          description: "The organizations you manage, by ID and name.",
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
          const organizations = await listManagedOrganizations({ database, actingAs: userId });
          return {
            content: [{ type: "text", text: JSON.stringify({ organizations }) }],
          };
        },
      );
      return server;
    },
    { legacy: "reject" },
  );

  return async (request: Request): Promise<Response> => {
    const claims = await verify(request);
    if (!claims) {
      const presented = request.headers.has("authorization");
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": presented ? `${challenge}, error="invalid_token"` : challenge,
        },
      });
    }
    return handler.fetch(request, {
      authInfo: {
        token: "",
        clientId: typeof claims.azp === "string" ? claims.azp : "",
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        extra: { userId: claims.sub },
      },
    });
  };
}
