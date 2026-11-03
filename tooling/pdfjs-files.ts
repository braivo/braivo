// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

import type { Plugin } from "vite-plus";

/**
 * pdf.js's support files, served at `/pdfjs/` from the console's own origin:
 * fetched by its PDF reader only when a PDF needs one, the standard fonts'
 * metrics, CJK character maps, and the JavaScript image decoders
 * (docs/adr/0055-pdf-text-in-the-browser.md). Not its WebAssembly, which the
 * console's policy would refuse to compile. Copied from the installed
 * `pdfjs-dist`, so they always match its version: served in development and
 * tests, emitted into a build.
 */
export function pdfjsFiles(): Plugin {
  const root = dirname(
    createRequire(new URL("../apps/console/package.json", import.meta.url)).resolve(
      "pdfjs-dist/package.json",
    ),
  );
  const files = [
    ...["cmaps", "standard_fonts"].flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => `${dir}/${name}`),
    ),
    "wasm/openjpeg_nowasm_fallback.js",
    "wasm/jbig2_nowasm_fallback.js",
  ];
  const served = new Set(files);

  return {
    name: "braivo:pdfjs-files",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (request, response, next) => {
        // Names are plain ASCII, so the path is matched as sent.
        const path = new URL(request.url ?? "", "http://x").pathname.slice(1);
        if (!served.has(path)) return next();
        // A module script must be served as JavaScript; the rest as bytes.
        response.setHeader(
          "Content-Type",
          extname(path) === ".js" ? "text/javascript" : "application/octet-stream",
        );
        response.end(readFileSync(join(root, path)));
      });
    },
    generateBundle() {
      for (const path of files) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/${path}`,
          source: readFileSync(join(root, path)),
        });
      }
    },
  };
}
