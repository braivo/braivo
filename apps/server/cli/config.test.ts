// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { readDatabaseUrl, readServeConfig } from "./config.ts";

const valid = {
  DATABASE_URL: "postgres://localhost/braivo",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BRAIVO_URL: "https://learn.example.com",
};

describe("serve configuration", () => {
  test("reads a complete environment, defaulting the port", () => {
    expect(readServeConfig(valid)).toEqual({
      databaseUrl: "postgres://localhost/braivo",
      secret: "a".repeat(32),
      baseUrl: "https://learn.example.com",
      port: 3000,
    });
  });

  test.each(["DATABASE_URL", "BETTER_AUTH_SECRET", "BRAIVO_URL"])(
    "names %s when it is missing",
    (name) => {
      expect(() => readServeConfig({ ...valid, [name]: undefined })).toThrow(`${name} is not set.`);
    },
  );

  test.each(["", "   "])(
    "treats a required value of %o as unset rather than as a value",
    (blank) => {
      expect(() => readServeConfig({ ...valid, DATABASE_URL: blank })).toThrow(
        "DATABASE_URL is not set.",
      );
    },
  );

  test("does not let whitespace stand in for a secret of the right length", () => {
    // Thirty-two spaces are thirty-two characters, and would otherwise sign
    // every session cookie this installation issues.
    expect(() => readServeConfig({ ...valid, BETTER_AUTH_SECRET: " ".repeat(32) })).toThrow(
      "BETTER_AUTH_SECRET is not set.",
    );
  });

  test("rejects a secret under Better Auth's minimum", () => {
    expect(() => readServeConfig({ ...valid, BETTER_AUTH_SECRET: "a".repeat(31) })).toThrow(
      "BETTER_AUTH_SECRET must be at least 32 characters, got 31.",
    );
  });

  test("accepts a secret of exactly the minimum length", () => {
    expect(readServeConfig({ ...valid, BETTER_AUTH_SECRET: "a".repeat(32) }).secret).toHaveLength(
      32,
    );
  });

  test.each(["not-a-url", "learn.example.com", "/api", ""])("rejects %o as a base URL", (value) => {
    expect(() => readServeConfig({ ...valid, BRAIVO_URL: value })).toThrow("BRAIVO_URL");
  });

  test("rejects a base URL that is not http or https", () => {
    // It parses, so only an explicit protocol check catches it.
    expect(() => readServeConfig({ ...valid, BRAIVO_URL: "ftp://learn.example.com" })).toThrow(
      "BRAIVO_URL must be an http or https URL",
    );
  });

  test.each([
    ["a path", "http://localhost:3000/learn"],
    ["a query", "http://localhost:3000?tenant=x"],
    ["a fragment", "http://localhost:3000#top"],
    ["credentials", "http://user:pass@localhost:3000"],
    ["a password alone", "http://:pass@localhost:3000"],
  ])("rejects a base URL carrying %s", (_label, value) => {
    // Each of these parses. A path is the dangerous one: Better Auth takes it as
    // its base path while the API mounts at /api/auth, and every auth request
    // 404s on a server that otherwise looks healthy.
    expect(() => readServeConfig({ ...valid, BRAIVO_URL: value })).toThrow("must be a bare origin");
  });

  test.each([
    ["a trailing slash", "https://learn.example.com/"],
    ["surrounding whitespace", "  https://learn.example.com  "],
    ["odd casing", "HTTPS://Learn.Example.COM"],
    ["its protocol's default port spelled out", "https://learn.example.com:443"],
  ])("normalises a base URL with %s", (_label, value) => {
    // Better Auth parses this value again and is stricter than `new URL`: the
    // untrimmed string makes it throw after the server has started.
    expect(readServeConfig({ ...valid, BRAIVO_URL: value }).baseUrl).toBe(
      "https://learn.example.com",
    );
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("falls back to 3000 when PORT is %s", (_label, value) => {
    // An empty PORT used to become 0, which Bun serves on a random free port —
    // a server that announces a URL nobody can reach it at.
    expect(readServeConfig({ ...valid, PORT: value }).port).toBe(3000);
  });

  test("uses a port that is actually a port", () => {
    expect(readServeConfig({ ...valid, PORT: "8080" }).port).toBe(8080);
  });

  test.each(["1", "65535"])("accepts %o at the edge of the range", (value) => {
    expect(readServeConfig({ ...valid, PORT: value }).port).toBe(Number(value));
  });

  test.each(["abc", "0", "-1", "65536", "80.5", "8080abc"])("rejects %o as a port", (value) => {
    expect(() => readServeConfig({ ...valid, PORT: value })).toThrow(
      `PORT must be a whole number between 1 and 65535, got "${value}".`,
    );
  });
});

describe("the database URL alone", () => {
  test("is readable without the rest of the serve settings", () => {
    // `db migrate` needs only this one, and must not demand a signing secret.
    expect(readDatabaseUrl({ DATABASE_URL: "postgres://localhost/braivo" })).toBe(
      "postgres://localhost/braivo",
    );
  });

  test("names itself when missing", () => {
    expect(() => readDatabaseUrl({})).toThrow("DATABASE_URL is not set.");
  });
});
