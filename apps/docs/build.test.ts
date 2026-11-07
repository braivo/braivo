// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

/**
 * The settings ADR 0057 lets an installation set at build, proven on the built
 * site: a base, an origin, and a brand from outside `apps/docs`, at each place
 * a page leads a reader or a crawler; and the default build's routes.
 */

const app = fileURLToPath(new URL(".", import.meta.url));
// Under apps/docs, ignored: Astro bundles a build writing outside the directory
// it runs in through `apps/docs/.astro/.prerender`, which another such build at
// the same time deletes from under it; inside, each keeps its own.
mkdirSync(join(app, ".astro"), { recursive: true });
const work = mkdtempSync(join(app, ".astro", "build-test-"));

/** Builds the site into a directory of `work`, with these settings alone. */
function build(name: string, settings: Record<string, string>): string {
  const out = join(work, name);
  // Not this process's environment: a test runner's own `BASE_URL` and the like
  // would override the build's.
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  const result = spawnSync("bun", ["--bun", "astro", "build", "--outDir", out], {
    cwd: app,
    env: { ...env, ...settings },
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`${name} build failed:\n${result.stdout}${result.stderr}`);
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) =>
    name.replaceAll("\\", "/"),
  );
}

const read = (out: string, path: string) => readFileSync(join(out, path), "utf8");

/** Every `url` of the search index. */
function searchUrls(out: string): string[] {
  const urls: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "url" && typeof inner === "string" && inner.startsWith("/")) urls.push(inner);
        else walk(inner);
      }
    }
  };
  walk(JSON.parse(read(out, "docs/search.json")));
  return urls;
}

let branded: string;
let unpublished: string;
let neutral: string;

beforeAll(() => {
  const brand = join(work, "brand");
  mkdirSync(brand);
  writeFileSync(
    join(brand, "site.ts"),
    'export default { name: "Fernwood Help", head: \'<meta name="brand-marker" content="fernwood">\' };\n',
  );
  writeFileSync(join(brand, "brand.css"), ":root { --brand-marker: 7px; }\n");
  const shared = { BRAIVO_DOCS_BASE: "/help/", BRAIVO_DOCS_BRAND: brand };
  branded = build("branded", { ...shared, BRAIVO_DOCS_URL: "https://docs.example" });
  unpublished = build("unpublished", shared);
  neutral = build("neutral", {});
}, 600_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("a build at /help/, with an outside brand and an origin", () => {
  test("leads every reader's way under /help/", () => {
    expect(read(branded, "index.html")).toContain("url=/help/docs");
    const faq = read(branded, "guides/faq.html");
    expect(faq).toContain('href="/help/guides/');
    expect(faq).not.toMatch(/(?:href|src)="\/(?!help\/)/);
    expect(faq).toContain('href="/help/docs/favicon.svg"');
    expect(read(branded, "guides/first-course.html")).toContain(
      'src="/help/docs/screenshots/first-course/1-add-material.png"',
    );
    expect(read(branded, "404.html")).toContain('href="/help/docs"');
    // The bare base is the host's other site's, on a shared host (deployment guide).
    const leadingHome = files(branded)
      .filter((name) => name.endsWith(".html"))
      .filter((name) => read(branded, name).includes('href="/help/"'));
    expect(leadingHome).toEqual([]);
  });

  test("searches under /help/, from its own index", () => {
    const urls = searchUrls(branded);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith("/help/"))).toEqual([]);
    // The client's address for the index, as the bundle writes it: the base in it.
    const fetched = files(join(branded, "docs/assets"))
      .filter((name) => name.endsWith(".js"))
      .flatMap((name) => [
        ...read(branded, `docs/assets/${name}`).matchAll(
          /from:\s*(`(?:[^`]|`[^`]*`)*?docs\/search\.json`|"[^"]*docs\/search\.json")/g,
        ),
      ])
      .map(([, address]) => address!);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.filter((address) => !address.includes("/help"))).toEqual([]);
  });

  test("wears the brand: its name, head tags, and styles", () => {
    const faq = read(branded, "guides/faq.html");
    expect(faq).toContain("<title>Questions schools ask · Fernwood Help</title>");
    expect(faq).toContain('<meta name="brand-marker" content="fernwood">');
    const styles = files(join(branded, "docs/assets"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => read(branded, `docs/assets/${name}`));
    expect(styles.some((css) => css.includes("--brand-marker"))).toBe(true);
  });

  test("names each page's canonical address, and lists them in docs/sitemap.xml", () => {
    expect(read(branded, "guides/faq.html")).toContain(
      '<link rel="canonical" href="https://docs.example/help/guides/faq">',
    );
    const sitemap = read(branded, "docs/sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
    expect(locs).toContain("https://docs.example/help/guides/faq");
    expect(locs.filter((loc) => !loc!.startsWith("https://docs.example/help/"))).toEqual([]);
  });
});

test("without an origin, a build names no canonical address and writes no sitemap", () => {
  expect(read(unpublished, "guides/faq.html")).not.toContain('rel="canonical"');
  expect(existsSync(join(unpublished, "docs/sitemap.xml"))).toBe(false);
});

test("the default build's routes are its pages, at the root", () => {
  const content = join(app, "content");
  const pages = files(content)
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => (name === "docs/index.mdx" ? "docs.html" : name.replace(/\.mdx$/, ".html")));
  const routes = files(neutral).filter((name) => name.endsWith(".html"));
  expect(routes.sort()).toEqual(["404.html", "index.html", ...pages].sort());
  expect(read(neutral, "index.html")).toContain("url=/docs");
  expect(relative(app, neutral)).not.toBe("dist");
});
