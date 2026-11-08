// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { bootLanguage } from "@braivo/i18n/boot";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

import { readDevPorts } from "../../tooling/dev-ports.ts";
import { braivoApi, learnApp } from "../../tooling/dev-proxy.ts";
import { pdfjsFiles } from "../../tooling/pdfjs-files.ts";

/**
 * The content owners' app, served from the root of Braivo's own origin
 * alongside the API (docs/adr/0004-one-application-origin.md).
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, "../..", ["BRAIVO_", "PORT"]);
  const ports = readDevPorts(env);

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
      pdfjsFiles(),
    ],
    // The PDF reader's worker is a module, as pdf.js is
    // (docs/adr/0055-pdf-text-in-the-browser.md).
    worker: { format: "es" as const },
    // Found at first only through the PDF worker, these would re-optimize mid-session
    // and mix two React bundle generations (Invalid hook call): optimized up front.
    optimizeDeps: { include: ["pdfjs-dist", "pdfjs-dist/build/pdf.worker.mjs"] },
    // Links to a `.localhost` learn domain reach the learn app's dev server, at the demo's
    // port or `bun run dev`'s (`@braivo/auth-client`'s `learnUrl`); a build's are HTTPS alone.
    ...(command === "serve" && {
      define: {
        "import.meta.env.BRAIVO_LEARN_PORT": JSON.stringify(String(ports.learn)),
      },
    }),
    server: {
      port: ports.console,
      strictPort: true,
      // `/learn` is Braivo's own learn app, as the origin's router sends it there (ADR 0059).
      proxy: { ...braivoApi(env), ...learnApp(env) },
    },
  };
});
