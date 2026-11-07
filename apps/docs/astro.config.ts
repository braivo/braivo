// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from "node:url";

import fumadocs from "@fumadocs/astro";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite-plus";

import { docsPort, readDevPorts } from "../../tooling/dev-ports.ts";
import { brandDirectory, brandSite, docsBase, docsUrl } from "./lib/build-settings.ts";
import { mdastPlugins } from "./lib/plugins.ts";

const env = loadEnv("development", "../..", ["BRAIVO_", "PORT"]);

const contentDir = fileURLToPath(new URL("content", import.meta.url));

/**
 * Set at build (ADR 0057), each once: where the site sits, its public origin,
 * and what brands it. From the build's own environment alone, never the env
 * files, whose development values would otherwise reach a production build.
 */
const base = docsBase(process.env.BRAIVO_DOCS_BASE);
const site = docsUrl(process.env.BRAIVO_DOCS_URL);
const brand = brandDirectory(
  process.env.BRAIVO_DOCS_BRAND,
  fileURLToPath(new URL("brand", import.meta.url)),
);
// Read once here, so a brand without a name fails the build, naming it.
await brandSite(brand);

/**
 * Braivo's public documentation, static files with no server (ADR 0057). Pages
 * sit under `docs/` and `guides/`, and so do its assets and search index, so
 * it can share a host with another site.
 *
 * `dev` passes `--ignore-lock`: without it, Astro detaches from an AI agent's
 * shell, leaving a server behind that `bun run dev` cannot stop.
 *
 * `astro` is pinned to the version `@fumadocs/astro` is tested with: on 7.4.7,
 * code blocks render nested and unhighlighted, with no build error (ADR 0057).
 */
export default defineConfig({
  srcDir: ".",
  base,
  site,
  trailingSlash: "never",
  build: { format: "file", assets: "docs/assets" },
  redirects: { "/": `${base}docs` },
  server: { port: docsPort(readDevPorts(env)) },
  devToolbar: { enabled: false },
  integrations: [
    fumadocs({
      collections: {
        docs: {
          dir: "content",
          components: "./components/mdx.tsx",
          mdastPlugins: mdastPlugins(contentDir, base),
        },
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // `#brand/` is `apps/docs/brand/` unless BRAIVO_DOCS_BRAND names another.
    resolve: { alias: [{ find: /^#brand\//, replacement: `${brand}/` }] },
  },
});
