// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "vite-plus";

/** What the shadcn CLI generates into `packages/ui` (ADR 0011, ADR 0012). */
const shadcnOutput = [
  "packages/ui/components/**",
  "packages/ui/hooks/**",
  "packages/ui/lib/**",
  "packages/ui/styles/**",
  "packages/ui/components.json",
];

/** Braivo's own files among them: stories sit beside the components they show. */
const beside = ["!packages/ui/components/**/*.stories.tsx"];

/**
 * Server and database code, and what the server imports from other packages,
 * kept off Bun's own APIs so the server can run on Workers too (ADR 0034). `node:` modules stay allowed, since node-postgres needs
 * Workers' Node compatibility anyway; whether workerd runs a given one is for a
 * deployment to prove.
 */
const bunFree = ["apps/server/**/*.ts", "packages/db/**/*.ts", "packages/i18n/locales.ts"];
const bunFreeMessage =
  "A Bun-only API, kept out of code the server runs: see bunFree in vite.config.ts.";

/** Exempt, as only the Bun process runs them: the CLI, the file stores it builds, and tests. */
const bunOnly = [
  "apps/server/cli/**",
  "apps/server/storage/bucket.ts",
  "apps/server/storage/directory.ts",
  "**/*.test.ts",
];

/**
 * For a test project rendering marked copy (ADR 0035): its macros compiled and
 * catalogs loaded as in the apps, and English active.
 */
const localized = (name: string, root: string) => ({
  plugins: [lingui({ macroTransform: true })],
  test: {
    name,
    root,
    environment: "happy-dom",
    setupFiles: ["../../packages/i18n/test-setup.ts"],
  },
});

/**
 * Workspace policy: how every package is linted, formatted, type-checked,
 * tested, and gated on commit. Each app's own `vite.config.ts` says only how
 * that app is served and built. See docs/adr/0003-workspace-layout.md.
 */
export default defineConfig({
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error" },
    rules: {
      "import/no-cycle": "error",
    },
    env: { builtin: true },
    // `vp check` type-checks too, so it is the one static gate for people and
    // agents alike rather than one of two.
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/dist/**", "apps/*/routeTree.gen.ts"],
    overrides: [
      {
        files: ["**/*.tsx"],
        plugins: ["react"],
      },
      {
        files: bunFree,
        excludeFiles: bunOnly,
        rules: {
          "no-restricted-globals": [
            "error",
            {
              globals: [{ name: "Bun", message: bunFreeMessage }],
              checkGlobalObject: true,
              // Beside the defaults, `globalThis`, `self`, and `window`.
              globalObjects: ["global"],
            },
          ],
          "no-restricted-imports": [
            "error",
            { patterns: [{ regex: "^bun(:|$)", message: bunFreeMessage }] },
          ],
          // Banned, so `require("bun")` cannot slip past the import rule.
          "typescript/no-require-imports": "error",
        },
      },
      {
        // The HTTP layer reaches other modules through their `index.ts`, and
        // never `persistence`: a route calls a use case. Its tests seed through
        // `persistence`, and their fixture, `testing.ts`, uses other modules'
        // test support. Restates bunFree's pattern, which this rule replaces.
        files: ["apps/server/api/**/*.ts"],
        excludeFiles: ["**/*.test.ts", "apps/server/api/testing.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                { regex: "^bun(:|$)", message: bunFreeMessage },
                {
                  regex: "^\\.\\./persistence(/|$)",
                  message: "A route calls a use case in `application`, not `persistence`.",
                },
                {
                  group: ["../*/**", "!../*/index.ts"],
                  message: "Another module's API is its `index.ts`.",
                },
              ],
            },
          ],
        },
      },
      {
        // shadcn's code, held to the rules that find bugs rather than to this
        // repository's taste; a local fix here is a patch to carry on every update.
        files: [...shadcnOutput, ...beside],
        plugins: ["react"],
        rules: {
          "react/set-state-in-effect": "off",
          "typescript/restrict-template-expressions": "off",
        },
      },
    ],
  },

  fmt: {
    sortImports: true,
    ignorePatterns: [
      "**/dist/**",
      "apps/*/routeTree.gen.ts",
      "packages/db/migrations/**",
      // Kept as shadcn writes them, so `shadcn add --diff` shows only real
      // differences rather than every line reformatted.
      ...shadcnOutput,
      ...beside,
    ],
  },

  staged: {
    "*": "vp check --fix",
  },

  test: {
    projects: [
      {
        test: {
          name: "server",
          root: "apps/server",
          // The database suites share one PostgreSQL database, so one file at
          // a time keeps them from cutting across each other.
          fileParallelism: false,
          globalSetup: ["../../tooling/require-bun.ts", "../../tooling/test-database.ts"],
        },
      },
      { test: { name: "db", root: "packages/db" } },
      { test: { name: "tooling", root: "tooling" } },
      localized("i18n", "packages/i18n"),
      localized("ui", "packages/ui"),
      localized("auth-client", "packages/auth-client"),
      localized("learn", "apps/learn"),
      localized("console", "apps/console"),
    ],
  },
});
