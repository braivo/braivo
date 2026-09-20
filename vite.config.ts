// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vite-plus";

/** What the shadcn CLI generates into `packages/ui` (ADR 0012, ADR 0013). */
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
 * Workspace policy: how every package is linted, formatted, type-checked,
 * tested, and gated on commit. Each app's own `vite.config.ts` says only how
 * that app is served and built. See docs/adr/0003-workspace-layout.md.
 */
export default defineConfig({
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error" },
    rules: { "import/no-cycle": "error" },
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
          globalSetup: "../../tooling/require-bun.ts",
        },
      },
      { test: { name: "tooling", root: "tooling" } },
      { test: { name: "ui", root: "packages/ui", environment: "happy-dom" } },
      { test: { name: "auth-client", root: "packages/auth-client", environment: "happy-dom" } },
      { test: { name: "learn", root: "apps/learn", environment: "happy-dom" } },
      { test: { name: "console", root: "apps/console", environment: "happy-dom" } },
    ],
  },
});
