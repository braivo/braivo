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

  // Literal names: changing how one is cut would orphan that worktree's database.
  describe("past PostgreSQL's 63 bytes", () => {
    const configured = "postgres://localhost/braivo_test";

    test("cuts the id and ends the name in a hash of the whole", () => {
      const id = "abc-12-a-long-branch-name-a-tool-gave-this-worktree-folder";
      expect(worktreeDatabase(configured, id)).toEqual({
        url: "postgres://localhost/braivo_test_abc-12-a-long-branch-name-a-tool-gave-this_071bb8d3",
        name: "braivo_test_abc-12-a-long-branch-name-a-tool-gave-this_071bb8d3",
      });
    });

    test("keeps a name of exactly 63 bytes, and cuts one of 64", () => {
      expect(worktreeDatabase(configured, "w".repeat(51)).name).toBe(
        `braivo_test_${"w".repeat(51)}`,
      );
      expect(worktreeDatabase(configured, "w".repeat(52)).name).toBe(
        `braivo_test_${"w".repeat(42)}_3a102b00`,
      );
    });

    test("keeps ids differing only past the cut apart", () => {
      expect(worktreeDatabase(configured, `${"w".repeat(60)}a`).name).not.toBe(
        worktreeDatabase(configured, `${"w".repeat(60)}b`).name,
      );
    });

    test("cuts on a character boundary", () => {
      expect(worktreeDatabase(configured, `x${"é".repeat(40)}`).name).toBe(
        `braivo_test_x${"é".repeat(20)}_d5707955`,
      );
      expect(worktreeDatabase(configured, "😀".repeat(20)).name).toBe(
        `braivo_test_${"😀".repeat(10)}_cafc511e`,
      );
    });

    test("refuses a configured name leaving no room for a character of the id", () => {
      expect(() =>
        worktreeDatabase(`postgres://localhost/${"d".repeat(52)}`, "😀".repeat(10)),
      ).toThrow("Shorten TEST_DATABASE_URL's database name");
    });
  });

  test("refuses a URL naming no database", () => {
    expect(() => worktreeDatabase("postgres://localhost", "x1")).toThrow("names no database");
  });
});
