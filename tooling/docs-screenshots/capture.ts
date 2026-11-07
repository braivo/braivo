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
import {
  createScratchDatabase,
  dropScratchDatabase,
  numberCourse,
  type ScratchDatabase,
} from "./database.ts";
import { DRAFT, PDF_TITLE, TOOL_WORK, handoutPdf } from "./material.ts";

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

/**
 * The moment every run happens at, the demo's own seeding date (docs/demo.md):
 * the classroom is seeded at it, and the server and the browsers read it as
 * now, so times on the pages, standings, and estimated recall come out the
 * same in every run, on a date a reader takes for real.
 *
 * The clock is let go while a learner signs in on the learn site: the
 * database checks that code's expiry against its own clock
 * (`clock_timestamp()`), which a past moment would fail, and the learner's
 * pages pictured show no date. A future moment would pass, but dates reading
 * years ahead look like a bug to a teacher.
 */
const NOW = new Date("2026-10-12T09:00:00Z");

/** This process's `Date` reads `NOW` as now, one given a time as ever, until the function returned is called. */
function freezeClock(): () => void {
  const Real = Date;
  const now = NOW.getTime();
  class Frozen extends Real {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(now);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return now;
    }
  }
  globalThis.Date = Frozen as DateConstructor;
  return () => {
    globalThis.Date = Real;
  };
}

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

async function signIn(page: Page, base: string, email: string, codes: Map<string, string>) {
  const code = () => codes.get(email);
  // A code mailed for an earlier sign-in is spent: wait for this one's.
  codes.delete(email);
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
 * Run in the page: `clip` grown to cover every line of text, control, and
 * image it cuts through, with a little room; one wholly inside or outside
 * stays as it is. A string, as this package's types know no DOM.
 */
const STRADDLING = `(clip) => {
  const cuts = (r) =>
    r.width > 1 && r.height > 1 && r.right - 1 <= innerWidth &&
    r.right > clip.x && r.left < clip.right && r.bottom > clip.y && r.top < clip.bottom &&
    (r.left < clip.x || r.right > clip.right || r.top < clip.y || r.bottom > clip.bottom);
  const rects = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    rects.push(...range.getClientRects());
  }
  for (const element of document.querySelectorAll("button, input, select, textarea, img, svg, [role=checkbox]")) {
    rects.push(element.getBoundingClientRect());
  }
  const grown = { ...clip };
  for (const r of rects.filter(cuts)) {
    grown.x = Math.min(grown.x, r.left - 8);
    grown.y = Math.min(grown.y, r.top - 4);
    grown.right = Math.max(grown.right, r.right + 8);
    grown.bottom = Math.max(grown.bottom, r.bottom + 8);
  }
  return grown;
}`;

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
  const viewport = page.viewportSize()!;
  let clip = {
    x: Math.max(0, Math.min(...boxes.map((box) => box.x)) - 16),
    y: Math.max(0, Math.min(...boxes.map((box) => box.y)) - 4),
    right: Math.min(viewport.width, Math.max(...boxes.map((box) => box.x + box.width)) + 16),
    bottom: Math.max(...boxes.map((box) => box.y + box.height)) + 8,
  };
  // Grown until no text or control straddles an edge, so nothing shows cut in half.
  for (let pass = 0; ; pass++) {
    const grown = (await page.evaluate(`(${STRADDLING})(${JSON.stringify(clip)})`)) as typeof clip;
    // No further than the screen: what reaches its edge is whole as shown.
    const next = {
      x: Math.max(0, grown.x),
      y: Math.max(0, grown.y),
      right: Math.min(viewport.width, grown.right),
      bottom: grown.bottom,
    };
    if (JSON.stringify(next) === JSON.stringify(clip)) break;
    if (pass === 5) throw new Error(`${path}: something still straddles the picture's edge.`);
    clip = next;
  }
  if (clip.bottom > viewport.height) throw new Error(`${path}: taller than the viewport.`);
  const { x, y } = clip;
  const right = clip.right;
  const bottom = clip.bottom;
  await page.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y } });
  console.log(
    `  ${path.split("/").slice(-2).join("/")}  ${Math.round(right - x)}×${Math.round(bottom - y)}`,
  );
}

/** A browser at the phone width, light, and at `NOW`. */
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...SCREEN, colorScheme: "light" });
  await context.clock.setFixedTime(NOW);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

async function firstCourse(
  scratch: ScratchDatabase,
  realTime: (steps: () => Promise<void>) => Promise<void>,
  browser: Browser,
  out: string,
  work: string,
  codes: Map<string, string>,
): Promise<Page> {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  const learnUrl = `http://fernwood.localhost:${PORTS.learn}`;
  const shot = (name: string) => join(out, "first-course", `${name}.png`);
  mkdirSync(join(out, "first-course"));
  const page = await newPage(browser);

  await signIn(page, consoleUrl, PERSONAS.author.email, codes);

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
  const edit = page.getByRole("button", {
    name: "Edit “What is the green pigment in leaves called?”",
  });
  const explanation = page.getByText("Shown after a miss");
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
  await numberCourse(scratch, "Why plants are green", 2026);
  await page.reload();
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
  const learner = await newPage(browser);
  // On the real clock: see NOW. Frozen again after, so the author's session
  // from the frozen moment still holds for what follows.
  await realTime(async () => {
    await signIn(learner, learnUrl, PERSONAS.sam.email, codes);
    await learner
      .getByRole("link", { name: /Why plants are green/ })
      .first()
      .click();
    await learner.waitForURL(/\/c\//);
    // Off the options: a hover left by the click reads as a chosen answer.
    await learner.mouse.move(0, 0);
    const show = learner.getByText("Show answer");
    await show.waitFor();
    const check = learner.getByRole("button", { name: "Check" });
    await region(learner, shot("7-learner"), learner.getByText(/^New · /), show, check);
  });
  return page;
}

/**
 * The progress tables need 684px, wider than a phone's 480: at 740 they fit
 * whole, with the sidebar still folded away.
 */
const WIDE = { width: 740, height: 2400 };

/** The follow-progress guide, as the demo's teacher: their group, its course's progress, and one learner. */
async function followProgress(browser: Browser, out: string, codes: Map<string, string>) {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  const shot = (name: string) => join(out, "follow-progress", `${name}.png`);
  mkdirSync(join(out, "follow-progress"));
  const page = await newPage(browser);
  await signIn(page, consoleUrl, PERSONAS.teacher.email, codes);

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
  const learnerColumn = page.getByRole("columnheader", { name: "Learner", exact: true });
  // The whole table, every standing's column; the guide shows it in a frame
  // that scrolls on a phone (`.wide-shot` in apps/docs/styles.css).
  const dueColumn = page.getByRole("columnheader", { name: "Due for review" });
  await region(
    page,
    shot("2-learners"),
    learnerColumn,
    page.getByRole("rowheader").filter({ hasText: PERSONAS.zofia.name }),
    dueColumn.first(),
  );
  const objectiveColumn = page.getByRole("columnheader", { name: "Objective", exact: true });
  const lastObjective = page.getByRole("rowheader").filter({ hasText: "Say goodbye" });
  await region(page, shot("3-objectives"), objectiveColumn, lastObjective, dueColumn.last());

  // 4. One learner's report.
  await page.setViewportSize(SCREEN.viewport);
  await sam.click();
  const report = page.getByRole("heading", { level: 1, name: PERSONAS.sam.name });
  await report.waitFor();
  await sees(page, "Standing", "Evidence", "Review due");
  const last = page.getByText("Not started", { exact: true }).last();
  await region(page, shot("4-learner"), report, last, report);
}

/** The capture's own tool, signed in as `braivo` is (ADR 0022): a device code the author approves at /device. */
async function toolToken(page: Page, consoleUrl: string): Promise<string> {
  const post = (path: string, body: unknown) =>
    fetch(`${consoleUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json() as Promise<Record<string, string>>);
  const code = await post("/api/auth/device/code", { client_id: "braivo-cli" });
  await page.goto(code.verification_uri_complete!);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Signed in. You can go back to your terminal.").waitFor();
  const token = await post("/api/auth/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
    client_id: "braivo-cli",
  });
  if (!token.access_token) throw new Error(`No token: ${JSON.stringify(token)}`);
  return token.access_token;
}

/**
 * The review guide: a course and questions a tool wrote through the API, as an
 * AI app or `braivo` would, waiting for the author in the console (ADR 0039).
 */
async function reviewAndPublish(scratch: ScratchDatabase, page: Page, out: string) {
  const consoleUrl = `http://127.0.0.1:${PORTS.console}`;
  mkdirSync(join(out, "review-and-publish"));
  // The author's own page from the first course: Braivo mails an address one
  // code a minute, and this run's clock never leaves its minute.
  const token = await toolToken(page, consoleUrl);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${consoleUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Record<string, any>;
  };
  const { organizations } = await api("GET", "/organizations");
  const org = organizations.find((o: { slug: string }) => o.slug === "fernwood").id;
  const { sources } = await api("GET", `/organizations/${org}/sources`);
  const sourceId = sources.find((s: { title: string }) => s.title === PDF_TITLE).id;
  const { objectiveIds } = await api("POST", `/organizations/${org}/objectives`, {
    objectives: TOOL_WORK.objectives.map(({ title, key }) => ({ title, key })),
  });
  await api("POST", `/organizations/${org}/citations`, {
    citations: TOOL_WORK.objectives.flatMap(({ quotes }, i) =>
      quotes.map((quote) => ({ objectiveId: objectiveIds[i], sourceId, quote })),
    ),
  });
  await api("POST", `/organizations/${org}/tasks`, {
    tasks: TOOL_WORK.objectives.flatMap(({ tasks }, i) =>
      tasks.map(({ quotes, ...task }) => ({
        objectiveId: objectiveIds[i],
        ...task,
        citations: quotes.map((quote) => ({ sourceId, quote })),
      })),
    ),
  });
  await api("POST", `/organizations/${org}/courses`, {
    title: TOOL_WORK.course,
    objectiveIds,
    key: "photosynthesis-check",
  });

  await numberCourse(scratch, TOOL_WORK.course, 2027);
  const shot = (name: string) => join(out, "review-and-publish", `${name}.png`);

  // 1. Under Courses, marked Needs review.
  await page.goto(`${consoleUrl}/fernwood`);
  const listed = page.getByRole("link", { name: new RegExp(TOOL_WORK.course) }).first();
  await listed.waitFor();
  await sees(page, "Courses", "Needs review");
  const courses = page.getByRole("heading", { level: 1, name: "Courses" });
  await region(page, shot("1-courses"), courses, listed, listed);
  await listed.click();

  // 2. A question waiting, with its answer, explanation, and passage.
  await page.waitForURL(/\/courses\//);
  const objective = page.getByText("1. Say what a plant takes in to make food").first();
  await objective.waitFor();
  await sees(
    page,
    "Needs review",
    "Unpublished",
    "Correct answer",
    "Edit",
    "Retire",
    "Delete course",
  );
  const select = page.getByRole("checkbox", {
    name: "Select unpublished task “Where does a plant take in water?”",
  });
  const passage = page
    .getByText("Leaves take in carbon dioxide from the air, and roots take up water from the soil.")
    .first();
  // Ticked, as the next step's picture counts it.
  await select.click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await region(page, shot("2-question"), objective, passage, select);

  // 3. Publishing all, or a selection.
  const withSelected = page.getByRole("button", { name: "Publish with selected (1)" });
  const withAll = page.getByRole("button", { name: "Publish with all (2)" });
  await withSelected.waitFor();
  // Off the checkbox, and past its transition: a hover or half-drawn tick differs from run to run.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  const intro = page.getByRole("heading", { level: 1, name: TOOL_WORK.course });
  await region(
    page,
    shot("3-publish"),
    intro,
    page.getByRole("button", { name: "Delete course" }),
    withAll,
  );
  await withAll.click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole("button", { name: /^Publish/ }).click();
  }

  // 4. What learners get.
  const course = page.getByRole("heading", { level: 1, name: TOOL_WORK.course });
  const hide = page.getByRole("button", { name: "Hide from learners" });
  await hide.waitFor();
  await sees(page, "Copy address", "Hide from learners");
  await region(
    page,
    shot("4-published"),
    course,
    hide,
    page.getByRole("button", { name: "Copy address" }),
  );
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
  // Its group, even once `vp` has exited: Vite, its child, may outlive it.
  const running = child.exitCode === null && child.signalCode === null;
  const exited = running ? new Promise((resolve) => child.once("exit", resolve)) : undefined;
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (exited) await Promise.race([exited, Bun.sleep(10_000)]);
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
      now: NOW,
    });

    let thaw = freezeClock();
    const realTime = async (steps: () => Promise<void>) => {
      thaw();
      try {
        await steps();
      } finally {
        thaw = freezeClock();
      }
    };
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
      const author = await firstCourse(scratch, realTime, browser, out, work, codes);
      await reviewAndPublish(scratch, author, out);
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
