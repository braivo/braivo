// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

/**
 * What Storybook's Vite builder adds to its own configuration: Tailwind, so
 * `@braivo/ui/globals.css` compiles as it does in the apps, and Lingui, so
 * marked copy does too (ADR 0035).
 */
export default defineConfig({
  plugins: [lingui({ macroTransform: true }), tailwindcss()],
});
