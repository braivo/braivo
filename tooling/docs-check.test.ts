// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { check } from "./docs-check.ts";

const existing = new Set(["apps/server/api/app.ts", "docs/specs/access.md"]);
const exists = (path: string) => existing.has(path);

const living = (body: string) => `# Area\n\nStatus: living; checked on 2026-10-19.\n\n${body}`;
const entryPoints = "## Entry points\n\n`apps/server/api/app.ts` (routes).\n";

describe("docs check", () => {
  test("passes when every named path exists", () => {
    expect(check([{ path: "docs/specs/access.md", text: living(entryPoints) }], exists)).toEqual(
      [],
    );
  });

  test("names the file and line of a path that does not exist", () => {
    const text = "# Guide\n\nStart at `apps/server/api/gone.ts`.\n";
    expect(check([{ path: "docs/guides/api.md", text }], exists)).toEqual([
      "docs/guides/api.md:3: `apps/server/api/gone.ts` does not exist",
    ]);
  });

  test("checks a path a command names", () => {
    const text = "Run `bun tooling/gone.ts serve` first.\n";
    expect(check([{ path: "AGENTS.md", text }], exists)).toEqual([
      "AGENTS.md:1: `tooling/gone.ts` does not exist",
    ]);
  });

  test("skips placeholders, globs, and text that is not a repository path", () => {
    const text = "`docs/specs/<area>.md`, `apps/*`, `api/index.ts`, `bun run test`\n";
    expect(check([{ path: "AGENTS.md", text }], exists)).toEqual([]);
  });

  test("requires entry points in a living spec, not in a planned one or the README", () => {
    const planned = "# Area\n\nStatus: planned.\n";
    expect(
      check(
        [
          { path: "docs/specs/access.md", text: living("## Code map\n") },
          { path: "docs/specs/billing.md", text: planned },
          { path: "docs/specs/README.md", text: living("") },
        ],
        exists,
      ),
    ).toEqual(['docs/specs/access.md: a living spec has no "## Entry points" section']);
  });
});
