// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

import { LOCALES } from "./packages/i18n/locales.ts";

/**
 * Where marked copy is extracted from, into one catalog per language
 * (docs/adr/0035-lingui-localization.md). Read by Lingui's CLI and by its Vite
 * plugin, which compiles the catalogs on import.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: [...LOCALES],
  catalogs: [
    {
      path: "<rootDir>/packages/i18n/locales/{locale}",
      include: [
        "<rootDir>/apps/learn",
        "<rootDir>/apps/console",
        "<rootDir>/packages/auth-client",
        "<rootDir>/packages/ui/compositions",
      ],
      exclude: ["**/node_modules/**", "**/*.test.*", "**/*.stories.*"],
    },
  ],
  // Without line numbers, moving copy does not rewrite the catalogs.
  format: formatter({ lineNumbers: false }),
});
