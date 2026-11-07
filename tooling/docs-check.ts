// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the documentation's pointers true: every path that `AGENTS.md`, a
 * document in `docs/` or `docs/specs/`, or a public page in `apps/docs/content/`
 * names exists; every link of a public page reaches a page and a heading that
 * exist, and every image is there and described; no public page or the README
 * offers one installation's address as an example; and every living spec has the `## Entry points` section
 * `docs/specs/README.md` asks for. Whether an entry point is still the right
 * place to start is left to review.
 *
 * ADRs are not checked: each records a decision as of its date, so a path it
 * names may since have gone.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

import GithubSlugger from "github-slugger";

export type Document = { path: string; text: string };

const codeSpan = /`([^`]+)`/g;

/**
 * A word of a code span under `apps/`, `packages/`, `tooling/`, or `docs/`, so
 * a command's argument counts (`bun tooling/worktree-setup.ts`); not one with
 * a placeholder (`<area>`) or a glob.
 */
const repositoryPath = /^(?:apps|packages|tooling|docs)\/[^<>*]+$/;

/** A public page, whose links must also work on GitHub and at its route (ADR 0057). */
const PAGES = "apps/docs/content/";

/**
 * One installation's address, which product text never offers as a reader's:
 * examples say braivo.example. The exceptions, each a whole address in its own
 * file: the installers in authoring, and the README's licensing contact.
 */
const INSTALLATION_ALLOWED: Record<string, readonly string[]> = {
  "apps/docs/content/guides/authoring.mdx": [
    "https://braivo.app/install.sh",
    "https://braivo.app/install.ps1",
  ],
  "README.md": ["hello@braivo.app", "mailto:hello@braivo.app"],
};

/** Each address naming braivo.app, whole: up to a space, bracket, or quote, a sentence's end aside. */
function installationAddresses(line: string): string[] {
  return [...line.matchAll(/[^\s()<>[\]"'`|]*braivo\.app[^\s()<>[\]"'`|]*/g)].map(([address]) =>
    address.replace(/[.,;:!?]+$/, ""),
  );
}

export function check(documents: Document[], exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  const texts = new Map(documents.map(({ path, text }) => [path, text]));
  for (const { path, text } of documents) {
    if (path.startsWith(PAGES)) problems.push(...checkLinks(path, text, texts, exists));
    if (path.startsWith(PAGES) || path === "README.md") {
      text.split("\n").forEach((line, index) => {
        const allowed = INSTALLATION_ALLOWED[path] ?? [];
        if (installationAddresses(line).some((address) => !allowed.includes(address))) {
          problems.push(
            `${path}:${index + 1}: names braivo.app, one installation's address: write braivo.example`,
          );
        }
      });
    }
    text.split("\n").forEach((line, index) => {
      for (const [, code] of line.matchAll(codeSpan)) {
        for (const named of code!.split(/\s+/)) {
          if (repositoryPath.test(named) && !exists(named)) {
            problems.push(`${path}:${index + 1}: \`${named}\` does not exist`);
          }
        }
      }
    });
    if (isLivingSpec(path, text) && !/^## Entry points$/m.test(text)) {
      problems.push(`${path}: a living spec has no "## Entry points" section`);
    }
  }
  return problems;
}

function checkLinks(
  path: string,
  text: string,
  texts: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const { line, number } of outsideFences(text)) {
    // The site's build rewrites inline links and images alone, so a reference's
    // target would reach the reader as a `.mdx` file.
    const definition = /^ {0,3}(\[[^\]]+\]:\s*\S+)/.exec(line)?.[1];
    if (definition) {
      problems.push(
        `${path}:${number}: \`${definition}\` is a reference definition, which the site does not rewrite: write the link inline, as \`[text](./page.mdx)\``,
      );
      continue;
    }
    const prose = line.replace(/`[^`]*`/g, "");
    for (const [, image, alt, href] of prose.matchAll(/(!)?\[([^\]]*)\]\(([^)\s]+)/g)) {
      const problem = image
        ? checkImage(href!, alt!, path, exists)
        : /^[a-z]+:/.test(href!)
          ? undefined
          : checkLink(href!, path, texts, exists);
      if (problem) problems.push(`${path}:${number}: ${problem}`);
    }
  }
  return problems;
}

function checkLink(
  href: string,
  from: string,
  texts: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): string | undefined {
  const [file, anchor] = href.split("#");
  let target = from;
  if (file) {
    target = posix.normalize(posix.join(posix.dirname(from), file));
    if (!/^\.{1,2}\//.test(file) || !file.endsWith(".mdx") || !target.startsWith(PAGES)) {
      return `\`${href}\` is neither an address nor a page's file, as \`./page.mdx\``;
    }
    if (!exists(target)) return `\`${href}\` does not exist`;
  }
  if (anchor && !headings(texts.get(target) ?? "").has(anchor)) {
    return `\`${href}\` names no heading of ${target}`;
  }
  return undefined;
}

/** Relative to its page, so it shows on GitHub too; the site serves `public/` at its root. */
function checkImage(
  href: string,
  alt: string,
  from: string,
  exists: (path: string) => boolean,
): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(from), href));
  if (!href.startsWith("../") || !target.startsWith("apps/docs/public/")) {
    return `\`${href}\` is not a file under the site's \`public/\`, as \`../../public/docs/a.png\``;
  }
  if (!exists(target)) return `\`${href}\` does not exist`;
  return alt.trim() ? undefined : `\`${href}\` has no alt text`;
}

/**
 * A page's heading IDs, GitHub's and the site's slugs alike: what both renderings
 * give a link to land on. A component's attribute is no target: GitHub can't run it.
 */
function headings(text: string): Set<string> {
  const slugger = new GithubSlugger();
  const ids = new Set<string>();
  for (const { line } of outsideFences(text)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading)
      ids.add(slugger.slug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "")));
  }
  return ids;
}

function outsideFences(text: string): { line: string; number: number }[] {
  const lines: { line: string; number: number }[] = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) lines.push({ line, number: index + 1 });
  });
  return lines;
}

function isLivingSpec(path: string, text: string): boolean {
  return /^docs\/specs\/(?!README\.md$)[^/]+\.md$/.test(path) && /^Status: living/m.test(text);
}

/**
 * A path Git ignores is generated, such as a build's output, so it may be
 * missing from a fresh checkout and counts as existing. Asked also with a
 * trailing `/`, as a pattern such as `dist/` matches only a directory, which a
 * missing path is not.
 */
export function existsOrIgnored(path: string): boolean {
  const ignored = (target: string) =>
    spawnSync("git", ["check-ignore", "--quiet", target]).status === 0;
  return existsSync(path) || ignored(path) || ignored(`${path}/`);
}

function read(path: string): Document {
  return { path, text: readFileSync(path, "utf8") };
}

/** Joined with `/`, not `path.join`, whose `\` on Windows would hide every spec from `isLivingSpec`. */
function markdownIn(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `${directory}/${name}`);
}

function pagesIn(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => `${directory}/${name.replaceAll("\\", "/")}`);
}

function main() {
  const paths = [
    "AGENTS.md",
    "README.md",
    ...["docs", "docs/specs"].flatMap(markdownIn),
    ...pagesIn("apps/docs/content"),
  ];
  const problems = check(paths.map(read), existsOrIgnored);
  if (problems.length === 0) {
    console.log(`Checked ${paths.length} documents: no missing paths or entry points.`);
    return;
  }
  console.error(`- ${problems.join("\n- ")}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
