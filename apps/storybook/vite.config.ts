// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

/**
 * What Storybook's Vite builder adds to its own configuration: Tailwind, so
 * `@braivo/ui/globals.css` compiles as it does in the apps.
 */
export default defineConfig({
  plugins: [tailwindcss()],
});
