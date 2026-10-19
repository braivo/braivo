// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the documentation's pointers into the code true: every path that
 * `AGENTS.md` or a document in `docs/`, `docs/specs/`, or `docs/guides/` names
 * exists, and every living spec has the `## Entry points` section
 * `docs/specs/README.md` asks for. Whether an entry point is still the right
 * place to start is left to review.
 *
 * ADRs are not checked: each records a decision as of its date, so a path it
 * names may since have gone.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

export type Document = { path: string; text: string };

const codeSpan = /`([^`]+)`/g;

/**
 * A word of a code span under `apps/`, `packages/`, `tooling/`, or `docs/`, so
 * a command's argument counts (`bun tooling/worktree-setup.ts`); not one with
 * a placeholder (`<area>`) or a glob.
 */
const repositoryPath = /^(?:apps|packages|tooling|docs)\/[^<>*]+$/;

export function check(documents: Document[], exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  for (const { path, text } of documents) {
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

function isLivingSpec(path: string, text: string): boolean {
  return /^docs\/specs\/(?!README\.md$)[^/]+\.md$/.test(path) && /^Status: living/m.test(text);
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

function main() {
  const paths = ["AGENTS.md", ...["docs", "docs/specs", "docs/guides"].flatMap(markdownIn)];
  const problems = check(paths.map(read), existsSync);
  if (problems.length === 0) {
    console.log(`Checked ${paths.length} documents: no missing paths or entry points.`);
    return;
  }
  console.error(`- ${problems.join("\n- ")}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
