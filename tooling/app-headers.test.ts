// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Both apps' security headers, in one guard as they are one policy: each
// `public/_headers` is copied into the build, where Workers' static assets, or
// a self-hoster's proxy, apply it (docs/guides/deployment.md).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

const read = (app: string, file: string) =>
  readFileSync(join(import.meta.dirname, "../apps", app, file), "utf8");

/**
 * `entries` by name, failing on a name given twice: a browser heeds a policy's
 * first `frame-ancestors`, say, so a later one would pass here and not there.
 */
function unique(entries: [string, string][]): Map<string, string> {
  const names = entries.map(([name]) => name);
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  return new Map(entries);
}

/** The headers `_headers` sets on every path (`/*`), by lowercased name. */
function headers(app: string): Map<string, string> {
  const [path, ...lines] = read(app, "public/_headers").trimEnd().split("\n");
  expect(path).toBe("/*");
  return unique(
    lines.map((line) => {
      expect(line).toMatch(/^ {2}\S/);
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
}

/** A policy's directives, by lowercased name, each with its sources. */
const directives = (policy: string) =>
  unique(
    policy
      .split(";")
      .filter((directive) => directive.trim() !== "")
      .map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name!.toLowerCase(), sources.join(" ")];
      }),
  );

test("both apps send one policy", () => {
  expect(read("learn", "public/_headers")).toBe(read("console", "public/_headers"));
});

test.each(["console", "learn"])(
  "%s may not be framed, and runs scripts from its own origin alone",
  (app) => {
    const sent = headers(app);
    const policy = directives(sent.get("content-security-policy") ?? "");
    // No site can frame the console's handoff, whose click framing would hijack
    // (access-14), or a learn domain's sign-in.
    expect(policy.get("frame-ancestors")).toBe("'none'");
    // No inline script, so none injected runs either.
    expect(policy.get("script-src")).toBe("'self'");
    // Nor can a page re-point its relative URLs, post a form elsewhere, or embed a plugin.
    expect(policy.get("base-uri")).toBe("'none'");
    expect(policy.get("form-action")).toBe("'self'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(sent.get("x-content-type-options")).toBe("nosniff");
    expect(sent.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  },
);

test.each(["console", "learn"])(
  "%s's index.html has no inline script the policy would block",
  (app) => {
    const scripts = [...read(app, "index.html").matchAll(/<script\b([^>]*)>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    // Resolved as a browser does, so `//host/…` or `/\host/…` counts as another origin.
    const origin = "https://app.example";
    const sources = scripts.map(([, attributes]) => /\ssrc=(["'])(.*?)\1/i.exec(attributes!)?.[2]);
    expect(sources.filter((src) => !src || new URL(src, origin).origin !== origin)).toEqual([]);
  },
);
