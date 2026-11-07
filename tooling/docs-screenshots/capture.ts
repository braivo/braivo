// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regenerates the first-course guide's screenshots by walking the guide through
 * the real server, console, and learn app, on the demo's classroom, in a
 * database it creates and drops. `bun run docs:screenshots`; needs what the demo
 * needs (docs/demo.md), and no AI key.
 *
 * Only the AI's answer is canned: the script answers the model's address itself,
 * so a run spends nothing and draws the same pictures. Braivo checks that answer
 * as it does a model's, every quote against the source.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { readServeConfig } from "../../apps/server/config.ts";
import { prepareClassroom, PERSONAS } from "../../apps/server/fixtures/classroom.ts";
import { createServer } from "../../apps/server/server.ts";
import { directoryStore } from "../../apps/server/storage/directory.ts";
import { createDatabase, runMigrations } from "../../packages/db/index.ts";
import { createScratchDatabase, dropScratchDatabase } from "./database.ts";
import { DRAFT, PDF_TITLE, handoutPdf } from "./material.ts";

const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "apps/docs/public/docs/screenshots/first-course");
const PORTS = { server: 4830, console: 4831, learn: 4832 };

/** The model's address, answered here with the canned draft; anything else goes out as usual. */
function cannedModel() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith("https://api.anthropic.com/")) {
      // The model's one caller sends a string.
      const { tools } = JSON.parse(init?.body as string) as { tools: { name: string }[] };
      const content = [{ type: "tool_use", id: "canned", name: tools[0]!.name, input: DRAFT }];
      return Response.json({ stop_reason: "tool_use", content });
    }
    return real(input, init);
  }) as typeof fetch;
}

async function waitFor(url: string) {
  for (let tries = 0; tries < 120; tries++) {
    if (
      await fetch(url).then(
        (r) => r.status < 500,
        () => false,
      )
    )
      return;
    await Bun.sleep(500);
  }
  throw new Error(`${url} did not answer.`);
}

async function signIn(page: Page, base: string, email: string, code: () => string | undefined) {
  await page.goto(`${base}/login`);
  await page.getByLabel(/email/i).first().fill(email);
  await page
    .getByRole("button", { name: /continue|send|sign in/i })
    .first()
    .click();
  const field = page.getByLabel("Code");
  await field.waitFor();
  for (let tries = 0; tries < 40 && !code(); tries++) await Bun.sleep(250);
  await field.fill(code()!);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Every label the guide names on this screen, so a renamed one fails here, not in a reader's hands. */
async function sees(page: Page, ...labels: string[]) {
  for (const label of labels) {
    await page.getByText(label, { exact: true }).first().waitFor({ timeout: 5_000 });
  }
}

async function walk(browser: import("playwright").Browser, codes: Map<string, string>) {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  const learnUrl = `http://fernwood.localhost:${PORTS.learn}`;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const shot = async (name: string) => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`  ${name}.png  ${page.url().replace(consoleUrl, "")}`);
  };

  await signIn(page, consoleUrl, PERSONAS.author.email, () => codes.get(PERSONAS.author.email));

  // 1. Add the material.
  await sees(page, "Sources");
  await page.getByRole("link", { name: "Sources" }).first().click();
  await page.getByRole("heading", { name: "Add material" }).waitFor();
  await page.getByLabel("Title").fill(PDF_TITLE);
  const pdf = join(mkdtempSync(join(tmpdir(), "braivo-handout-")), "why-plants-are-green.pdf");
  writeFileSync(pdf, handoutPdf());
  await page.getByLabel("Original file").setInputFiles(pdf);
  await page.getByRole("heading", { name: "Add material" }).scrollIntoViewIfNeeded();
  await sees(page, "Add material", "Title", "Text", "Original file");
  await shot("1-add-material");
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("button", { name: "Save source" }).waitFor();
  await page.getByRole("button", { name: "Save source" }).scrollIntoViewIfNeeded();
  await sees(page, "Text", "Keep", "Leave out", "Save source");
  await shot("2-check-pages");
  await page.getByRole("button", { name: "Save source" }).click();

  // 2. Draft.
  await page.getByRole("heading", { name: "Draft a course" }).waitFor();
  await page.getByLabel("Learners").fill("Grade 5 science");
  await page.getByRole("heading", { name: "Draft a course" }).scrollIntoViewIfNeeded();
  await sees(page, "Learners", "Draft a course");
  await shot("3-draft");
  await page.getByRole("button", { name: "Draft a course" }).click();

  // 3. Review.
  await page.getByRole("heading", { name: "Review the draft" }).waitFor();
  await page.getByRole("heading", { name: "Review the draft" }).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 400);
  await sees(page, "Review the draft", "Edit", "Course title", "Create course");
  await shot("4-review");

  // 4. Create it.
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/courses\//);
  await page.getByRole("heading", { level: 1, name: "Why plants are green" }).waitFor();
  await sees(page, "Copy address", "Hide from learners", "Retire");
  await shot("5-course");

  // 5. As a learner.
  const learner = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const learnerPage = await learner.newPage();
  learnerPage.setDefaultTimeout(30_000);
  await signIn(learnerPage, learnUrl, PERSONAS.sam.email, () => codes.get(PERSONAS.sam.email));
  await learnerPage
    .getByRole("link", { name: /Why plants are green/ })
    .first()
    .click();
  await learnerPage.waitForURL(/\/c\//);
  await learnerPage.waitForLoadState("networkidle").catch(() => {});
  // Off the options: a hover left by the click reads as a chosen answer.
  await learnerPage.mouse.move(0, 0);
  await learnerPage.waitForTimeout(800);
  await learnerPage.screenshot({ path: join(OUT, "6-learner.png") });
  console.log(`  6-learner.png  ${learnerPage.url()}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const target = process.env.BRAIVO_DEMO_DATABASE_URL?.trim() || "postgres://localhost/postgres";
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const baseUrl = `http://127.0.0.1:${PORTS.console}`;
  const files = mkdtempSync(join(tmpdir(), "braivo-screenshots-"));
  const scratch = await createScratchDatabase(target);
  const children: ReturnType<typeof spawn>[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await runMigrations(scratch.url);
    await prepareClassroom({
      databaseUrl: scratch.url,
      authSecret: secret,
      baseUrl,
      now: new Date(),
    });

    cannedModel();
    const codes = new Map<string, string>();
    const environment = {
      DATABASE_URL: scratch.url,
      BETTER_AUTH_SECRET: secret,
      BRAIVO_URL: baseUrl,
      PORT: String(PORTS.server),
      BRAIVO_FILES: files,
      ANTHROPIC_API_KEY: "canned",
    };
    const config = readServeConfig(environment);
    const api = createServer({
      config,
      database: createDatabase(config.databaseUrl),
      files: directoryStore(files),
      // The code is the only six digits in the mail.
      sendMail: async (mail) => {
        const code = /\b\d{6}\b/.exec(mail.text)?.[0];
        if (code) codes.set(mail.to, code);
      },
    });
    server = Bun.serve({
      port: PORTS.server,
      hostname: "127.0.0.1",
      fetch: api.fetch,
      idleTimeout: 60,
    });

    for (const app of ["console", "learn"] as const) {
      children.push(
        spawn(
          join(ROOT, "node_modules/.bin/vp"),
          ["dev", "--host", "127.0.0.1", "--port", String(PORTS[app]), "--strictPort"],
          {
            cwd: join(ROOT, "apps", app),
            env: {
              ...process.env,
              BRAIVO_URL: baseUrl,
              PORT: String(PORTS.server),
              BRAIVO_LEARN_PORT: String(PORTS.learn),
            },
            stdio: "ignore",
            // Its own group: `vp` runs Vite in a child, which outlives a signal to `vp` alone.
            detached: true,
          },
        ),
      );
    }
    await waitFor(baseUrl);
    await waitFor(`http://127.0.0.1:${PORTS.learn}`);

    const browser = await chromium.launch();
    try {
      await walk(browser, codes);
    } catch (error) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.screenshot({ path: join(tmpdir(), "braivo-screenshots-failure.png") });
          console.error(
            `Failed at ${page.url()}; see ${join(tmpdir(), "braivo-screenshots-failure.png")}`,
          );
          console.error((await page.locator("body").innerText()).slice(0, 1500));
        }
      }
      throw error;
    } finally {
      await browser.close();
    }
  } finally {
    for (const child of children) process.kill(-child.pid!, "SIGTERM");
    await server?.stop(true);
    await dropScratchDatabase(scratch);
    rmSync(files, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
