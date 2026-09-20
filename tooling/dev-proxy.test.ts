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
  const { "/api": api } = braivoApi("http://localhost:3000/");
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
  test("presents the API's own origin for a request that is same-origin to the dev server", () => {
    expect(rewritten({ origin: "http://localhost:5173", host: "localhost:5173" })).toBe(
      "origin: http://localhost:3000",
    );
  });

  test("does not rewrite another site's origin", () => {
    expect(rewritten({ origin: "https://evil.example", host: "localhost:5173" })).toBeUndefined();
  });

  test("leaves a request carrying no origin alone", () => {
    expect(rewritten({ host: "localhost:5173" })).toBeUndefined();
  });
});
