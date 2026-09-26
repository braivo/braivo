// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

import { braivoApi } from "../../tooling/dev-proxy.ts";

/**
 * The content owners' app, served from the root of Braivo's own origin
 * alongside the API (docs/adr/0004-one-application-origin.md).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "BRAIVO_");

  return {
    plugins: [
      tanstackRouter({
        target: "react",
        routesDirectory: "./routes",
        generatedRouteTree: "./routeTree.gen.ts",
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    server: {
      port: 5174,
      strictPort: true,
      proxy: braivoApi(env.BRAIVO_URL ?? "http://localhost:3000"),
    },
  };
});
