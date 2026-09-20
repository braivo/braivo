// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  test.each(["/", "/courses/c1", "/courses/c1?tab=next"])("keeps %o", (value) => {
    expect(safeRedirect(value)).toBe(value);
  });

  test.each([
    undefined,
    1,
    "",
    "courses",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    // Stripped by the URL parser before it reads the rest, so each of these is
    // `//evil.example` by the time a browser acts on it.
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\t\\evil.example",
  ])("drops %o", (value) => {
    expect(safeRedirect(value)).toBeUndefined();
  });

  test("drops a destination that only leaves the origin once a browser reads it", () => {
    // The guard and the browser have to agree on where a value goes. Asserted
    // against the parser itself, so a rule that drifted from it fails here.
    for (const escaping of ["/\t/evil.example", "/\n//evil.example", "/\r\\evil.example"]) {
      expect(new URL(escaping, "https://braivo.app").origin).toBe("https://evil.example");
      expect(safeRedirect(escaping)).toBeUndefined();
    }
  });
});
