// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { worktreeDatabase } from "./test-database.ts";

describe("a worktree's test database", () => {
  test("suffixes the configured name, keeping the rest of the URL", () => {
    expect(
      worktreeDatabase("postgres://ada:secret@localhost:5432/braivo_test?sslmode=disable", "x1")
        .url,
    ).toBe("postgres://ada:secret@localhost:5432/braivo_test_x1?sslmode=disable");
  });

  test("names the database decoded, as PostgreSQL receives it", () => {
    expect(worktreeDatabase("postgres://localhost/braivo%20test", "x1")).toEqual({
      url: "postgres://localhost/braivo%20test_x1",
      name: "braivo test_x1",
    });
  });

  test("keeps Git's id as it is, so ids differing in case or punctuation stay apart", () => {
    expect(worktreeDatabase("postgres://localhost/braivo_test", "Hearty-Dusk.2").name).toBe(
      "braivo_test_Hearty-Dusk.2",
    );
  });

  test("refuses a name PostgreSQL would cut short", () => {
    expect(() => worktreeDatabase("postgres://localhost/braivo_test", "w".repeat(52))).toThrow(
      "longer than 63 bytes",
    );
  });

  test("refuses a URL naming no database", () => {
    expect(() => worktreeDatabase("postgres://localhost", "x1")).toThrow("names no database");
  });
});
