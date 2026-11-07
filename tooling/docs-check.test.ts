// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from "vite-plus/test";

import { check, existsOrIgnored } from "./docs-check.ts";

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
    expect(check([{ path: "apps/docs/content/guides/api.mdx", text }], exists)).toEqual([
      "apps/docs/content/guides/api.mdx:3: `apps/server/api/gone.ts` does not exist",
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

describe("links between public pages", () => {
  const page = "apps/docs/content/guides/authoring.mdx";
  const other = "apps/docs/content/guides/api.mdx";
  const files = (...paths: string[]) => new Set(paths);
  const run = (text: string, otherText = "## The walkthrough\n") =>
    check(
      [
        { path: page, text },
        { path: other, text: otherText },
      ],
      (path) => files(page, other).has(path),
    );

  test("refuses a reference definition, which the site would not rewrite, whatever its target", () => {
    const refused = (number: number, definition: string) =>
      `${page}:${number}: \`${definition}\` is a reference definition, which the site does not rewrite: write the link inline, as \`[text](./page.mdx)\``;
    expect(
      run(
        "[a](./api.mdx) [Start][a] [Gone][b] [Part][c]\n\n[a]: ./api.mdx\n[b]: ./not-a-page.mdx\n   [c]: ./api.mdx#the-walkthrough\n",
      ),
    ).toEqual([
      refused(3, "[a]: ./api.mdx"),
      refused(4, "[b]: ./not-a-page.mdx"),
      refused(5, "[c]: ./api.mdx#the-walkthrough"),
    ]);
    expect(run("```md\n[a]: ./api.mdx\n```\n")).toEqual([]);
  });

  test("passes a page, its heading, and an address", () => {
    expect(
      run(
        "## Own part\n\n[a](./api.mdx) [b](./api.mdx#the-walkthrough) [c](#own-part)\n[d](https://example.com/x)\n",
      ),
    ).toEqual([]);
  });

  test("names a page that does not exist", () => {
    expect(run("[a](./gone.mdx)\n")).toEqual([`${page}:1: \`./gone.mdx\` does not exist`]);
  });

  test("names a heading another page does not have", () => {
    expect(run("[a](./api.mdx#nowhere)\n")).toEqual([
      `${page}:1: \`./api.mdx#nowhere\` names no heading of ${other}`,
    ]);
  });

  test("names a heading its own page does not have", () => {
    expect(run("[a](#nowhere)\n")).toEqual([`${page}:1: \`#nowhere\` names no heading of ${page}`]);
  });

  test("slugs a heading as GitHub and the site do, repeats included", () => {
    expect(
      run(
        "[a](./api.mdx#the-braivo-command) [b](./api.mdx#ai-apps-1) [c](./api.mdx#an-organizations-domain)\n",
        "## The `braivo` command\n\n## AI apps\n\n## AI apps\n\n## An organization's [domain](https://example.com)\n",
      ),
    ).toEqual([]);
  });

  test("passes a question's heading inside a disclosure, as GitHub and the site both render it", () => {
    expect(
      run(
        "[a](./api.mdx#does-our-material-go-to-an-ai)\n",
        "<details>\n<summary>\n\n### Does our material go to an AI?\n\n</summary>\n\nNo.\n\n</details>\n",
      ),
    ).toEqual([]);
  });

  test("names a target only a component's attribute gives, which GitHub cannot render", () => {
    expect(
      run(
        "[a](./api.mdx#does-our-material-go-to-an-ai)\n",
        '<Accordion title="Does our material go to an AI?">\n',
      ),
    ).toEqual([
      `${page}:1: \`./api.mdx#does-our-material-go-to-an-ai\` names no heading of ${other}`,
    ]);
  });

  test("ignores what is in code, and a fence's fake heading", () => {
    expect(run("```text\n[a](./gone.mdx)\n## Fake\n```\n\n`[b](./gone.mdx)` [c](#fake)\n")).toEqual(
      [`${page}:6: \`#fake\` names no heading of ${page}`],
    );
  });

  test.each([
    ["a route, which 404s on GitHub", "/guides/api"],
    ["a file named without ./", "api.mdx"],
    ["a page's route without its extension", "./api"],
    ["a file outside the pages", "../../../../README.md"],
    ["a page outside the pages", "../../outside.mdx"],
  ])("refuses %s", (_, href) => {
    expect(run(`[a](${href})\n`)).toEqual([
      `${page}:1: \`${href}\` is neither an address nor a page's file, as \`./page.mdx\``,
    ]);
  });

  test("passes an image in the site's public files, described", () => {
    const image = "apps/docs/public/docs/a.png";
    expect(
      check(
        [{ path: page, text: "![The form](../../public/docs/a.png)\n" }],
        (path) => path === image,
      ),
    ).toEqual([]);
  });

  test("names an image that does not exist", () => {
    expect(run("![The form](../../public/docs/gone.png)\n")).toEqual([
      `${page}:1: \`../../public/docs/gone.png\` does not exist`,
    ]);
  });

  test("names an image without alt text", () => {
    const image = "apps/docs/public/docs/a.png";
    expect(
      check([{ path: page, text: "![](../../public/docs/a.png)\n" }], (path) => path === image),
    ).toEqual([`${page}:1: \`../../public/docs/a.png\` has no alt text`]);
  });

  test.each(["/docs/a.png", "./a.png", "https://example.com/a.png"])(
    "refuses an image at %s, which would not work in both places",
    (href) => {
      expect(run(`![The form](${href})\n`)).toEqual([
        `${page}:1: \`${href}\` is not a file under the site's \`public/\`, as \`../../public/docs/a.png\``,
      ]);
    },
  );

  test("leaves other documents' links alone", () => {
    expect(
      check([{ path: "docs/specs/access.md", text: "[a](/x) [b](./gone.mdx)\n" }], exists),
    ).toEqual([]);
  });
});

describe("one installation's address", () => {
  const authoring = "apps/docs/content/guides/authoring.mdx";
  const assistants = "apps/docs/content/guides/assistants.mdx";
  const named = (path: string, line: number) =>
    `${path}:${line}: names braivo.app, one installation's address: write braivo.example`;
  const run = (path: string, text: string) => check([{ path, text }], () => true);

  test("passes the installers in authoring, and the licensing contact in the README", () => {
    expect(
      run(
        authoring,
        "curl -fsSL https://braivo.app/install.sh | bash\nirm https://braivo.app/install.ps1 | iex\n",
      ),
    ).toEqual([]);
    expect(
      run("README.md", "Write to hello@braivo.app. Or [mail](mailto:hello@braivo.app).\n"),
    ).toEqual([]);
  });

  test("names braivo.app anywhere else in a public page or the README", () => {
    expect(run(assistants, "Add `https://braivo.app/mcp`.\n")).toEqual([named(assistants, 1)]);
    expect(run("README.md", "See braivo.app.\n")).toEqual([named("README.md", 1)]);
  });

  test("allows each exception only exactly, and only where it belongs", () => {
    expect(run(authoring, "curl -fsSL https://braivo.app/install.sh.evil | bash\n")).toEqual([
      named(authoring, 1),
    ]);
    expect(run(assistants, "curl -fsSL https://braivo.app/install.sh | bash\n")).toEqual([
      named(assistants, 1),
    ]);
    expect(run(assistants, "Write to hello@braivo.app.\n")).toEqual([named(assistants, 1)]);
    expect(run("README.md", "Open https://hello@braivo.app/x.\n")).toEqual([named("README.md", 1)]);
  });

  test("leaves engineering documents alone", () => {
    expect(run("docs/adr/0057-public-docs-site.md", "braivo.app\n")).toEqual([]);
  });
});

describe("existsOrIgnored", () => {
  test("counts an ignored build directory never built, as on a fresh checkout", () => {
    // `dist/` in .gitignore matches only a directory, which a missing path is not.
    expect(existsOrIgnored("tooling/never-built/dist")).toBe(true);
    expect(existsOrIgnored("tooling/never-built/output")).toBe(false);
  });
});
