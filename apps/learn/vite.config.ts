// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { bootLanguage } from "@braivo/i18n/boot";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

import { readDevPorts } from "../../tooling/dev-ports.ts";
import { braivoApi } from "../../tooling/dev-proxy.ts";

/** The learner-facing app, served at the root of an organization's own domain (ADR 0004). */
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
        macroTransform: true,
        // A build ships no language with a message missing or malformed
        // (ADR 0035); in development, untranslated copy shows its English.
        ...(command === "build" && { failOnMissing: "catalog", failOnCompileError: true }),
      }),
      react(),
      bootLanguage(),
      tailwindcss(),
    ],
    server: {
      port: readDevPorts(env).learn,
      strictPort: true,
      proxy: braivoApi(env),
    },
  };
});
