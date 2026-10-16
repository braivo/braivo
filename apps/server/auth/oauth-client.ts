// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isLoopbackIP } from "@better-auth/core/utils/host";

import type { Auth } from "./auth.ts";

/**
 * Registers a remote MCP client: the operator's command, the only way in
 * where client ID metadata documents are off (Workers, ADR 0045). Public, with
 * PKCE, never keys or a `jwks_uri`, which Better Auth would fetch unpinned.
 * Linked to `/mcp`, without which authorizing answers `invalid_target`.
 *
 * `clientId` defaults to a random one; a client naming itself by its metadata
 * document's URL (Claude Code) is registered under that URL, never fetched.
 */
export async function registerOAuthClient(
  auth: Auth,
  input: { name: string; redirectUris: readonly string[]; clientId?: string },
): Promise<{ clientId: string }> {
  const { name, redirectUris, clientId = crypto.randomUUID() } = input;
  // Started first: starting stores `/mcp`, the resource linked to, and a
  // refusal below must not end the process's database mid-start.
  const { adapter, baseURL } = await auth.$context;
  if (!name.trim()) throw new Error("A client needs a name, shown at consent.");
  // Refused, not trimmed: an ID is opaque, so a pasted space would be part of it.
  if (!clientId.trim() || clientId !== clientId.trim()) {
    throw new Error(`The client ID "${clientId}" is blank or has surrounding spaces.`);
  }
  if (redirectUris.length === 0) throw new Error("A client needs at least one redirect URI.");
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new Error(`${uri}: ${problem}`);
  }

  if (
    await adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] })
  ) {
    throw new Error(`A client is already registered as ${clientId}.`);
  }
  const now = new Date();
  await adapter.transaction(async (tx) => {
    await tx.create({
      model: "oauthClient",
      data: {
        clientId,
        name: name.trim(),
        redirectUris: [...redirectUris],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        requirePKCE: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.create({
      model: "oauthClientResource",
      data: { clientId, resourceId: new URL("/mcp", baseURL).href, createdAt: now },
    });
  });
  return { clientId };
}

/**
 * Removes a client and, by cascade, its refresh tokens and consents; `false`
 * if none had the ID. Its access tokens still verify until they expire,
 * within the hour, but `/mcp` refuses them, finding no consent (ADR 0045).
 * Where client ID metadata documents are on, a URL-named one can sign in again.
 */
export async function removeOAuthClient(auth: Auth, clientId: string): Promise<boolean> {
  const { adapter } = await auth.$context;
  const where = [{ field: "clientId", value: clientId }];
  if (!(await adapter.findOne({ model: "oauthClient", where }))) return false;
  await adapter.delete({ model: "oauthClient", where });
  return true;
}

/**
 * Better Auth's rules for a redirect URI, which writing the row skips: HTTPS
 * off the loopback, or HTTP on it, whose port it lets vary (RFC 8252). Read as
 * written, since the URI is matched exactly as stored: `https:client.example`
 * parses as `https://client.example`, and `http://127.1` as `127.0.0.1`.
 */
function redirectUriProblem(uri: string): string | undefined {
  if (!URL.canParse(uri)) return "not an absolute URL";
  // `@` and `\` refused outright: parsers disagree on where a host so
  // written ends (`http://localhost:80\@evil.example`). Whitespace and control
  // characters too, which parsing drops or encodes, so stored they never match.
  if (/[#@\\\s\p{Cc}]/u.test(uri)) {
    return "a redirect URI has no fragment, credentials, backslash, or whitespace";
  }
  const url = new URL(uri);
  const loopback =
    isLoopbackIP(url.hostname) ||
    url.hostname === "localhost" ||
    /^localhost\.+$/i.test(url.hostname);
  const written = /^http:\/\/(\[[^\]]*\]|[^/?#:]*)/.exec(uri)?.[1];
  if (uri.startsWith("https://") && !loopback) return undefined;
  if (["localhost", "127.0.0.1", "[::1]"].includes(written ?? "")) {
    return undefined;
  }
  return "https:// off the loopback, or http:// on exactly localhost, 127.0.0.1, or [::1]";
}
