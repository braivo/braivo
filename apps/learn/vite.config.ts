// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { bootLanguage } from "@braivo/i18n/boot";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

import { readDevPorts } from "../../tooling/dev-ports.ts";
import { braivoApi, LEARN_PREFIX, learnMount } from "../../tooling/dev-proxy.ts";

/**
 * The learner-facing app, served at the root of an organization's own domain
 * (ADR 0004) and at `/learn` and `/c/…` on the installation's origin (ADR 0059).
 * One build does both: its files are under `/learn/assets/` on either, clear
 * of the console's `/assets/`. The dev server keeps its modules under
 * `/learn/` too, where the console's proxies them (`learnMount`).
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
        macroTransform: true,
        // A build ships no language with a message missing or malformed
        // (ADR 0035); in development, untranslated copy shows its English.
        ...(command === "build" && { failOnMissing: "catalog", failOnCompileError: true }),
      }),
      react(),
      bootLanguage(),
      tailwindcss(),
      learnMount(env),
    ],
    // Links to a `.localhost` school domain reach this dev server's port
    // (`@braivo/auth-client`'s `learnUrl`); a build's are HTTPS alone.
    ...(command === "serve" && {
      define: {
        "import.meta.env.BRAIVO_LEARN_PORT": JSON.stringify(String(readDevPorts(env).learn)),
      },
    }),
    base: command === "serve" ? `${LEARN_PREFIX}/` : "/",
    build: { assetsDir: `${LEARN_PREFIX.slice(1)}/assets` },
    server: {
      port: readDevPorts(env).learn,
      strictPort: true,
      proxy: braivoApi(env),
    },
  };
});
