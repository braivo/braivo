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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
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

/** Each page's file under `content/`, such as `guides/faq.mdx`. */
const pages = () => files(join(app, "content")).filter((name) => name.endsWith(".mdx"));

/** Each page's Markdown copy, such as `guides/faq.md`. */
const copies = () => pages().map((name) => name.replace(/x$/, ""));

/** Every Markdown link's and image's destination. */
const markdownUrls = (markdown: string) =>
  [...markdown.matchAll(/\]\(([^)\s]+)/g)].map(([, url]) => url!);

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

  test("searches under /help/, from its own index", async () => {
    const urls = searchUrls(branded);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith("/help/"))).toEqual([]);
    // The index the browser fetches when a reader searches: under the base.
    const site = await serve(branded, "/help");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${site.url}/help/guides/faq`, { waitUntil: "load" });
      // Once the page's island has hydrated, as a click before that opens nothing.
      await page.waitForSelector("astro-island:not([ssr])");
      const fetched = page.waitForRequest((request) => request.url().endsWith("search.json"));
      await page
        .getByRole("button", { name: /search/i })
        .first()
        .click();
      await page.keyboard.type("course");
      expect(new URL((await fetched).url()).pathname).toBe("/help/docs/search.json");
    } finally {
      await browser.close();
      site.close();
    }
  }, 60_000);

  test("wears the brand: its name, head tags, and styles", () => {
    const faq = read(branded, "guides/faq.html");
    expect(faq).toContain("<title>Questions schools ask · Fernwood Help</title>");
    expect(faq).toContain('<meta name="brand-marker" content="fernwood">');
    const styles = files(join(branded, "docs/assets"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => read(branded, `docs/assets/${name}`));
    expect(styles.some((css) => css.includes("--brand-marker"))).toBe(true);
  });

  test("names each page's canonical address, and lists them in sitemap.xml at the base", () => {
    expect(read(branded, "guides/faq.html")).toContain(
      '<link rel="canonical" href="https://docs.example/help/guides/faq">',
    );
    // At the base: a sitemap under docs/ may not list /help/docs or /help/guides/*.
    expect(existsSync(join(branded, "docs/sitemap.xml"))).toBe(false);
    const sitemap = read(branded, "sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
    expect(locs).toContain("https://docs.example/help/docs");
    expect(locs).toContain("https://docs.example/help/guides/faq");
    expect(locs.filter((loc) => !loc!.startsWith("https://docs.example/help/"))).toEqual([]);
  });

  test("links each page's Markdown from docs/llms.txt, absolutely, each a file", () => {
    const urls = markdownUrls(read(branded, "docs/llms.txt"));
    expect(urls.sort()).toEqual(
      copies()
        .map((copy) => `https://docs.example/help/${copy}`)
        .sort(),
    );
    expect(copies().filter((copy) => !existsSync(join(branded, copy)))).toEqual([]);
  });

  test("holds every page's copy in docs/llms-full.txt", () => {
    const full = read(branded, "docs/llms-full.txt");
    expect(copies().filter((copy) => !full.includes(read(branded, copy).trim()))).toEqual([]);
  });

  test("exports links and images where the site serves them, base and section once", () => {
    for (const name of ["docs/llms-full.txt", ...copies()]) {
      const text = read(branded, name);
      // Any form a link could take, not only `](`: a JSX href, a reference definition.
      expect(text, name).not.toMatch(/\.\.?\/[^\s)"'`]*\.mdx\b|\.\.\/public\//);
      const urls = markdownUrls(text);
      expect(
        urls.filter((url) => !url.startsWith("#") && !url.startsWith("https://")),
        name,
      ).toEqual([]);
      // Each address on the site's origin is a file the build wrote, under the base once.
      const unserved = urls
        .filter((url) => url.startsWith("https://docs.example/"))
        .filter((url) => {
          const path = new URL(url).pathname;
          if (!path.startsWith("/help/")) return true;
          const file = join(branded, path.slice("/help/".length));
          return !existsSync(`${file}.html`) && !(existsSync(file) && extname(file) !== "");
        });
      expect(unserved, name).toEqual([]);
    }
    const guide = markdownUrls(read(branded, "guides/first-course.md"));
    expect(guide).toContain("https://docs.example/help/guides/prepare-material");
    expect(guide).toContain(
      "https://docs.example/help/docs/screenshots/first-course/1-add-material.png",
    );
    expect(markdownUrls(read(branded, "docs/index.md"))).toContain(
      "https://docs.example/help/guides/first-course",
    );
  });
});

test("without an origin, a build names no canonical address, writes no sitemap, and exports paths from the root", () => {
  expect(read(unpublished, "guides/faq.html")).not.toContain('rel="canonical"');
  expect(existsSync(join(unpublished, "sitemap.xml"))).toBe(false);
  expect(existsSync(join(unpublished, "docs/sitemap.xml"))).toBe(false);
  const urls = markdownUrls(read(unpublished, "docs/llms.txt"));
  expect(urls).toContain("/help/guides/faq.md");
  expect(urls.filter((url) => !url.startsWith("/help/"))).toEqual([]);
  expect(urls.filter((url) => !existsSync(join(unpublished, url.slice("/help/".length))))).toEqual(
    [],
  );
  const full = read(unpublished, "docs/llms-full.txt");
  // An origin only prose names, as the deployment guide's example.
  expect(markdownUrls(full).filter((url) => url.includes("docs.example"))).toEqual([]);
  expect(markdownUrls(full)).toContain("/help/guides/prepare-material");
  expect(markdownUrls(full)).toContain("/help/docs/screenshots/first-course/1-add-material.png");
});

test("a guide's Markdown keeps its steps, callouts, and headings; the index its cards' titles", () => {
  const guide = read(neutral, "guides/first-course.md");
  expect(guide).toMatch(/^# Your first course, in the console \(\/guides\/first-course\)\n/);
  expect(guide).toContain("<Step>");
  expect(guide).toContain("### Add your material");
  expect(guide).toContain("> [!WARNING]\n> If a scan has no selectable text");
  const index = read(neutral, "docs/index.md");
  for (const title of ["I teach", "I build with the API", "I run Braivo myself"]) {
    expect(index).toContain(`<Card title="${title}"`);
  }
  expect(read(neutral, "docs/llms.txt")).toMatch(/^# Braivo\n/);
});

test("the default build's routes are its pages, at the root, each with its Markdown beside it", () => {
  const html = pages().map((name) =>
    name === "docs/index.mdx" ? "docs.html" : name.replace(/\.mdx$/, ".html"),
  );
  const routes = files(neutral).filter((name) => name.endsWith(".html"));
  expect(routes.sort()).toEqual(["404.html", "index.html", ...html].sort());
  const markdown = files(neutral).filter((name) => /\.(md|txt|xml)$/.test(name));
  expect(markdown.sort()).toEqual(["docs/llms.txt", "docs/llms-full.txt", ...copies()].sort());
  expect(read(neutral, "index.html")).toContain("url=/docs");
  expect(relative(app, neutral)).not.toBe("dist");
});

/** Serves a build at `base` as a static host does: `/guides/faq` is `guides/faq.html`. */
async function serve(out: string, base = ""): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url!, "http://host").pathname);
    const path = pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
    const file = [join(out, path), join(out, `${path}.html`)].find(
      (candidate) => existsSync(candidate) && extname(candidate) !== "",
    );
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("shows a screenshot at most at its own width, a wide one scrolling in its frame on a phone", async () => {
  const site = await serve(neutral);
  const browser = await chromium.launch();
  try {
    for (const width of [375, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${site.url}/guides/follow-progress`, { waitUntil: "load" });
      const seen = await page.evaluate(() => ({
        pageOverflows: document.documentElement.scrollWidth > innerWidth,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        shots: [...document.querySelectorAll<HTMLImageElement>(".prose img")].map((img) => {
          const frame = img.closest(".wide-shot");
          return {
            src: img.getAttribute("src"),
            own: Number(img.getAttribute("width")),
            shown: img.getBoundingClientRect().width,
            wide: frame !== null,
            frameScrolls: frame !== null && frame.scrollWidth > frame.clientWidth,
          };
        }),
      }));
      await page.close();
      expect(seen.pageOverflows, `the page overflows at ${width}px`).toBe(false);
      expect(seen.shots.filter((shot) => shot.wide).length).toBeGreaterThan(0);
      for (const shot of seen.shots) {
        expect(shot.shown, `${shot.src} at ${width}px`).toBeLessThanOrEqual(shot.own);
        if (width === 375 && shot.wide) {
          expect(shot.shown, `${shot.src} at ${width}px`).toBe(Math.min(shot.own, 37 * seen.rem));
          expect(shot.frameScrolls, `${shot.src}'s frame at ${width}px`).toBe(true);
        }
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
}, 60_000);
