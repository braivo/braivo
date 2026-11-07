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
 *
 * The pictures are drawn into a temporary directory and replace the committed
 * ones only once every step has passed, so a failed run leaves them as they were.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Browser, chromium, type Locator, type Page } from "playwright";

import { readServeConfig } from "../../apps/server/config.ts";
import { prepareClassroom, PERSONAS } from "../../apps/server/fixtures/classroom.ts";
import { createServer } from "../../apps/server/server.ts";
import { directoryStore } from "../../apps/server/storage/directory.ts";
import { createDatabase, runMigrations } from "../../packages/db/index.ts";
import { createScratchDatabase, dropScratchDatabase, type ScratchDatabase } from "./database.ts";
import { DRAFT, PDF_TITLE, handoutPdf } from "./material.ts";

const ROOT = join(import.meta.dirname, "../..");
const SCREENSHOTS = join(ROOT, "apps/docs/public/docs/screenshots");
const PORTS = { server: 4830, console: 4831, learn: 4832 };

/**
 * A phone's width, so the console folds its sidebar away and a picture reads at
 * nearly its size on a phone and at its size beside the guide (`.prose img` in
 * apps/docs/styles.css shows it no wider); tall enough that each step's part of
 * the page fits once scrolled to, so coordinates are the viewport's.
 */
const SCREEN = {
  viewport: { width: 480, height: 2400 },
  deviceScaleFactor: 2,
  // Times on the pages read the same wherever this runs, and say nothing of where.
  timezoneId: "UTC",
  locale: "en-US",
} as const;

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
    await page
      .getByText(label, { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 5_000 });
  }
}

/**
 * The part of the page a step is about, from `from` to `to`, no wider than
 * what they and `presses` span: the sidebar left out, so labels come out near
 * the size they are read at. `presses`, what the step says to press, is
 * inside the picture by construction, and its absence fails the run.
 */
async function region(
  page: Page,
  path: string,
  from: Locator,
  to: Locator,
  presses: Locator,
): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  // To the top, whichever element scrolls, so what follows it fits below.
  await from.first().evaluate((node) => node.scrollIntoView({ block: "start" }));
  const boxes = [];
  for (const locator of [from, to, presses]) {
    const box = await locator.first().boundingBox();
    if (!box) throw new Error(`${path}: ${String(locator)} is not on the screen.`);
    boxes.push(box);
  }
  const margin = 24;
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin);
  const viewport = page.viewportSize()!;
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + margin,
  );
  // Less below: the next line would show its top half.
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + 8;
  if (bottom > viewport.height) throw new Error(`${path}: taller than the viewport.`);
  await page.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y } });
  console.log(
    `  ${path.split("/").slice(-2).join("/")}  ${Math.round(right - x)}×${Math.round(bottom - y)}`,
  );
}

async function firstCourse(
  browser: Browser,
  out: string,
  work: string,
  codes: Map<string, string>,
) {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  const learnUrl = `http://fernwood.localhost:${PORTS.learn}`;
  const shot = (name: string) => join(out, "first-course", `${name}.png`);
  mkdirSync(join(out, "first-course"));
  const page = await (await browser.newContext({ ...SCREEN, colorScheme: "light" })).newPage();
  page.setDefaultTimeout(30_000);

  await signIn(page, consoleUrl, PERSONAS.author.email, () => codes.get(PERSONAS.author.email));

  // 1. Add the material.
  // At a phone's width the sidebar is folded away; its Sources link opens this.
  await page.goto(`${consoleUrl}/fernwood/sources`);
  await sees(page, "Sources");
  const adding = page.getByRole("heading", { name: "Add material" });
  await adding.waitFor();
  await page.getByLabel("Title").fill(PDF_TITLE);
  const pdf = join(work, "why-plants-are-green.pdf");
  writeFileSync(pdf, handoutPdf());
  await page.getByLabel("Original file").setInputFiles(pdf);
  await sees(page, "Add material", "Title", "Text", "Original file");
  const add = page.getByRole("button", { name: "Add material", exact: true });
  await region(page, shot("1-add-material"), adding, add, add);
  await add.click();

  // 2. Check its pages. Pictured once the button is ready, not while it reads as unavailable.
  const save = page.getByRole("button", { name: "Save source", disabled: false });
  await save.waitFor();
  await sees(page, "Text", "Keep", "Leave out", "Next page", "Save source");
  await page.waitForTimeout(300);
  await region(
    page,
    shot("2-check-pages"),
    page.getByText(/^Printed page of page \d+$/),
    save,
    save,
  );
  await save.click();

  // 3. Draft.
  const drafting = page.getByRole("heading", { name: "Draft a course" });
  await drafting.waitFor();
  await page.getByLabel("Learners").fill("Grade 5 science");
  await sees(page, "Learners", "Draft a course");
  const draft = page.getByRole("button", { name: "Draft a course" });
  const promise = page.getByText("You review the draft before learners see any of it.");
  await region(page, shot("3-draft"), drafting, promise, draft);
  await draft.click();

  // 4. Review, editing one question as the guide says: Edit, then Save.
  const reviewing = page.getByRole("heading", { name: "Review the draft" });
  await reviewing.waitFor();
  await sees(page, "Review the draft", "Edit", "Course title", "Create course");
  const edit = page.getByRole("button", { name: "Edit “Why do plants look green?”" });
  const explanation = page.getByText(
    "Chlorophyll, the green pigment in leaves, reflects green light.",
  );
  await region(page, shot("4-review"), reviewing, explanation, edit);
  await edit.click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await edit.waitFor();

  // 5. Create it.
  const create = page.getByRole("button", { name: "Create course", disabled: false });
  const titled = page.getByText("Course title", { exact: true });
  const discard = page.getByRole("button", { name: "Discard draft" });
  await region(page, shot("5-create-course"), titled, discard, create);
  await create.click();

  // 6. Its page.
  await page.waitForURL(/\/courses\//);
  const course = page.getByRole("heading", { level: 1, name: "Why plants are green" });
  await course.waitFor();
  await sees(page, "Copy address", "Hide from learners", "Retire");
  const hide = page.getByRole("button", { name: "Hide from learners" });
  await region(
    page,
    shot("6-course"),
    course,
    hide,
    page.getByRole("button", { name: "Copy address" }),
  );

  // 7. As a learner.
  const learner = await (await browser.newContext({ ...SCREEN, colorScheme: "light" })).newPage();
  learner.setDefaultTimeout(30_000);
  await signIn(learner, learnUrl, PERSONAS.sam.email, () => codes.get(PERSONAS.sam.email));
  await learner
    .getByRole("link", { name: /Why plants are green/ })
    .first()
    .click();
  await learner.waitForURL(/\/c\//);
  // Off the options: a hover left by the click reads as a chosen answer.
  await learner.mouse.move(0, 0);
  const show = learner.getByText("Show answer");
  await show.waitFor();
  const option = learner.getByText("Roots take up green water");
  await region(learner, shot("7-learner"), learner.getByText(/^New · /), show, option);
}

/**
 * The progress tables need 684px, wider than a phone's 480: at 740 they fit
 * whole, with the sidebar still folded away. Such pictures are named `-wide`
 * (apps/docs/styles.css shows them across the column).
 */
const WIDE = { width: 740, height: 2400 };

/** The follow-progress guide, as the demo's teacher: their group, its course's progress, and one learner. */
async function followProgress(browser: Browser, out: string, codes: Map<string, string>) {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  const shot = (name: string) => join(out, "follow-progress", `${name}.png`);
  mkdirSync(join(out, "follow-progress"));
  const page = await (await browser.newContext({ ...SCREEN, colorScheme: "light" })).newPage();
  page.setDefaultTimeout(30_000);
  await signIn(page, consoleUrl, PERSONAS.teacher.email, () => codes.get(PERSONAS.teacher.email));

  // 1. Their groups, where a teacher's console opens.
  await page.goto(`${consoleUrl}/fernwood/groups`);
  const progress = page.getByRole("link", { name: "Progress" });
  await progress.waitFor();
  await sees(page, "Groups", "Class A English", "Progress");
  const groups = page.getByRole("heading", { level: 1, name: "Groups" });
  await region(page, shot("1-groups"), groups, progress, progress);
  await progress.click();

  // 2 and 3. The course's progress, its learners and its objectives.
  await page.setViewportSize(WIDE);
  const byObjective = page.getByRole("heading", { name: "Progress by objective" });
  await byObjective.waitFor();
  await sees(page, "Not started", "Learning", "Repeated misses", "Retained", "Due for review");
  const sam = page.getByRole("link", { name: PERSONAS.sam.name });
  const learners = page.getByRole("heading", { name: "Learners", exact: true });
  await region(
    page,
    shot("2-learners-wide"),
    learners,
    page.getByText("Last practised today").last(),
    sam,
  );
  const none = page.getByText("No objectives currently have repeated misses.");
  await region(page, shot("3-objectives-wide"), byObjective, none, none);

  // 4. One learner's report.
  await page.setViewportSize(SCREEN.viewport);
  await sam.click();
  const report = page.getByRole("heading", { level: 1, name: PERSONAS.sam.name });
  await report.waitFor();
  await sees(page, "Standing", "Evidence", "Review due");
  const last = page.getByText("Not started", { exact: true }).last();
  await region(page, shot("4-learner"), report, last, report);
}

/**
 * Stops what this run started, each apart, so one failure leaves the rest to
 * be tried; a process group already gone (ESRCH) is already stopped.
 */
async function cleanUp(steps: (() => unknown)[]) {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Cleaning up failed.");
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  await Promise.race([exited, Bun.sleep(10_000)]);
}

async function main() {
  const target = process.env.BRAIVO_DEMO_DATABASE_URL?.trim() || "postgres://localhost/postgres";
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const baseUrl = `http://127.0.0.1:${PORTS.console}`;
  const children: ChildProcess[] = [];
  let work: string | undefined;
  let scratch: ScratchDatabase | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    work = mkdtempSync(join(tmpdir(), "braivo-screenshots-"));
    const out = join(work, "out");
    const files = join(work, "files");
    mkdirSync(out);
    mkdirSync(files);
    scratch = await createScratchDatabase(target);
    await runMigrations(scratch.url);
    await prepareClassroom({
      databaseUrl: scratch.url,
      authSecret: secret,
      baseUrl,
      now: new Date(),
    });

    cannedModel();
    const codes = new Map<string, string>();
    const config = readServeConfig({
      DATABASE_URL: scratch.url,
      BETTER_AUTH_SECRET: secret,
      BRAIVO_URL: baseUrl,
      PORT: String(PORTS.server),
      BRAIVO_FILES: files,
      ANTHROPIC_API_KEY: "canned",
    });
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
      const child = spawn(
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
      );
      child.on("error", (error) => console.error(`${app}: ${error.message}`));
      children.push(child);
    }
    await waitFor(baseUrl);
    await waitFor(`http://127.0.0.1:${PORTS.learn}`);

    const browser = await chromium.launch();
    try {
      // Before the first course exists, so the teacher's pages show the demo as seeded.
      await followProgress(browser, out, codes);
      await firstCourse(browser, out, work, codes);
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

    // Every step passed: the new set replaces the committed one whole.
    rmSync(SCREENSHOTS, { recursive: true, force: true });
    cpSync(out, SCREENSHOTS, { recursive: true });
  } finally {
    await cleanUp([
      ...children.map((child) => () => stop(child)),
      () => server?.stop(true),
      () => scratch && dropScratchDatabase(scratch),
      () => work && rmSync(work, { recursive: true, force: true }),
    ]);
  }
}

await main();
process.exit(0);
