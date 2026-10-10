// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { bootLanguage } from "@braivo/i18n/boot";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

import { braivoApi } from "../../tooling/dev-proxy.ts";

/**
 * The content owners' app, served from the root of Braivo's own origin
 * alongside the API (docs/adr/0004-one-application-origin.md).
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, "../..", ["BRAIVO_", "PORT"]);

  return {
    plugins: [
      tanstackRouter({
        target: "react",
        routesDirectory: "./routes",
        generatedRouteTree: "./routeTree.gen.ts",
        autoCodeSplitting: true,
      }),
      lingui({
        // TSX, not inferred from the file name, which a route's split chunk
        // (`login.tsx?tsr-split=component`) hides. Every file importing a
        // macro is parsed so, a `.ts` one too: no `<T>x` casts there.
        macroTransform: { parser: { syntax: "typescript", tsx: true } },
        // A build ships no language with a message missing or malformed
        // (ADR 0035); in development, untranslated copy shows its English.
        ...(command === "build" && { failOnMissing: "catalog", failOnCompileError: true }),
      }),
      react(),
      bootLanguage(),
      tailwindcss(),
    ],
    server: {
      port: 5174,
      strictPort: true,
      proxy: braivoApi(env),
    },
  };
});
