// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { braivoApi, learnApp, learnMount } from "./dev-proxy.ts";

/**
 * Pins the condition on the rewrite: the tempting simplification — rewriting
 * every `Origin` — would make development accept writes production refuses,
 * and nothing else here would notice.
 */
function rewritten(headers: { origin?: string; host?: string }): string | undefined {
  // A trailing slash, as an `.env` would carry: the header has to be a bare
  // origin, which is what `braivoApi` normalizes to.
  const { "/api": api } = braivoApi({ BRAIVO_URL: "http://localhost:5174/" });
  let set: string | undefined;

  // Vite's proxy, as far as `configure` reaches into it.
  api?.configure?.(
    {
      on: (event: string, handler: (proxied: unknown, request: unknown) => void) => {
        if (event !== "proxyReq") return;
        handler(
          { setHeader: (name: string, value: string) => void (set = `${name}: ${value}`) },
          { headers },
        );
      },
    } as never,
    {} as never,
  );

  return set;
}

describe("the development API proxy", () => {
  test("presents the site's origin for a request that is same-origin to the dev server", () => {
    expect(rewritten({ origin: "http://localhost:5173", host: "localhost:5173" })).toBe(
      "origin: http://localhost:5174",
    );
  });

  test("presents an organization's domain as its HTTPS origin, as deployed", () => {
    expect(
      rewritten({ origin: "http://fernwood.localhost:5173", host: "fernwood.localhost:5173" }),
    ).toBe("origin: https://fernwood.localhost");
  });

  test("forwards to the server on `PORT`, not to `BRAIVO_URL`", () => {
    expect(braivoApi({ BRAIVO_URL: "http://localhost:5174" })["/api"]?.target).toBe(
      "http://localhost:3000",
    );
    expect(braivoApi({ PORT: "3100" })["/api"]?.target).toBe("http://localhost:3100");
    expect(braivoApi({ BRAIVO_URL: " ", PORT: "" })["/api"]?.target).toBe("http://localhost:3000");
  });

  test("serves remote MCP's endpoint and discovery from the server, `/mcp` exactly", () => {
    const proxied = braivoApi({ PORT: "3100" });
    expect(proxied["^/mcp$"]?.target).toBe("http://localhost:3100");
    expect(proxied["/.well-known/oauth-protected-resource"]?.target).toBe("http://localhost:3100");
  });

  test("does not rewrite another site's origin", () => {
    expect(rewritten({ origin: "https://evil.example", host: "localhost:5173" })).toBeUndefined();
  });

  test("does not rewrite the origin of another port on the same host", () => {
    expect(rewritten({ origin: "http://localhost:9999", host: "localhost:5173" })).toBeUndefined();
  });

  test("leaves a request carrying no origin alone", () => {
    expect(rewritten({ host: "localhost:5173" })).toBeUndefined();
  });
});

/** What the learn app's dev server does with `url` asked of `host`: serves it from `url`, or redirects. */
function mounted(url: string, host = "fernwood.localhost:5253"): string {
  let use:
    | ((
        request: { url: string; headers: { host: string } },
        response: unknown,
        next: () => void,
      ) => void)
    | undefined;
  (
    learnMount({ BRAIVO_URL: "http://localhost:5254", BRAIVO_LEARN_PORT: "5253" })
      .configureServer as (server: unknown) => void
  )({
    middlewares: { use: (handle: typeof use) => (use = handle) },
  });
  const request = { url, headers: { host } };
  let redirected: string | undefined;
  const response = {
    writeHead: (_status: number, headers: { location: string }) => {
      redirected = `redirect ${headers.location}`;
      return { end: () => {} };
    },
  };
  use!(request, response, () => {});
  return redirected ?? request.url;
}

describe("the learn app in development (ADR 0059)", () => {
  test("the console's dev server sends `/learn`, `/c/…`, and nothing else to the learn app's", () => {
    const routes = learnApp({ BRAIVO_LEARN_PORT: "5253" });
    for (const options of Object.values(routes)) {
      expect(options).toEqual({ target: "http://localhost:5253", ws: true });
    }
    const proxied = (path: string) => Object.keys(routes).some((key) => new RegExp(key).test(path));
    for (const path of ["/learn", "/learn/", "/learn/assets/x.js", "/learn?x=1", "/c/123", "/c"]) {
      expect(proxied(path), path).toBe(true);
    }
    // A slug beginning with either is an organization's console.
    for (const path of ["/", "/login", "/learner", "/cafe", "/fernwood/learn", "/assets/x.js"]) {
      expect(proxied(path), path).toBe(false);
    }
  });

  test("serves every page from its modules' prefix, the address unchanged", () => {
    expect(mounted("/")).toBe("/learn/");
    expect(mounted("/c/4732-spanish")).toBe("/learn/c/4732-spanish");
    expect(mounted("/login?redirect=%2F")).toBe("/learn/login?redirect=%2F");
    expect(mounted("/learn")).toBe("/learn/learn");
    expect(mounted("/learner")).toBe("/learn/learner");
  });

  test("leaves its modules, and what goes to the server, where they are", () => {
    for (const url of [
      "/learn/",
      "/learn/@vite/client",
      "/learn/assets/boot-language-1.js",
      "/api/session",
      "/api",
      "/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      expect(mounted(url)).toBe(url);
    }
  });

  test("sends the installation's hostname at its own port to the origin, where `/login` is the console's", () => {
    expect(mounted("/c/1?x=1", "localhost:5253")).toBe("redirect http://localhost:5254/c/1?x=1");
    // Proxied by the console's dev server, it keeps the console's host.
    expect(mounted("/c/1", "localhost:5254")).toBe("/learn/c/1");
  });
});
