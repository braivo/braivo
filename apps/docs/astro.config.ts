// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import fumadocs from "@fumadocs/astro";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite-plus";

import { docsPort, readDevPorts } from "../../tooling/dev-ports.ts";

const env = loadEnv("development", "../..", ["BRAIVO_", "PORT"]);

/**
 * Braivo's public documentation, static files with no server (ADR 0057). Pages
 * sit under `docs/` and `guides/`, and so do its assets and search index, so
 * it can share a host with another site.
 *
 * `dev` passes `--ignore-lock`: without it, Astro detaches from an AI agent's
 * shell, leaving a server behind that `bun run dev` cannot stop.
 */
export default defineConfig({
  srcDir: ".",
  trailingSlash: "never",
  build: { format: "file", assets: "docs/assets" },
  redirects: { "/": "/docs" },
  server: { port: docsPort(readDevPorts(env)) },
  devToolbar: { enabled: false },
  integrations: [
    fumadocs({ collections: { docs: { dir: "content", components: "./components/mdx.tsx" } } }),
  ],
  vite: { plugins: [tailwindcss()] },
});
