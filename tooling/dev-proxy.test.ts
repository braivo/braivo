// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { braivoApi } from "./dev-proxy.ts";

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
