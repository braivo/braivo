// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Runs a checkout's own drafting and reading (`draftCourse`, `extractPages`)
// through the production adapter on the evaluation fixtures, and records
// every run, failed ones included. Bypasses only the application's quota and
// ledger. Usage: README.md.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkDraft, checkReading, type GoalInMaterial } from "./checks.ts";
import { compareEvaluations } from "./compare.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/** The first 12 hex of the SHA-256 of `parts`, as prompt versions are. */
const hash = (...parts: (string | Uint8Array)[]) => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex").slice(0, 12);
};

export type Fixture = {
  kind: "draft" | "read";
  file: string;
  origin: string;
  rights: string;
  review: string;
  title?: string;
  language?: string;
  /** Ignored by a checkout that does not read a goal, so a baseline shows the draft without one. */
  goal?: string;
  audience?: string;
  instructionLanguage?: string;
  /**
   * What the checks hold titles, prompts, and explanations to when no tag is
   * sent: the learners' language as the audience says it. Never sent.
   */
  expectedInstructionLanguage?: string;
  mediaType?: string;
  offTopic?: string[];
  goalInMaterial?: GoalInMaterial;
  outsideMaterial?: string[];
  lines?: string[];
  order?: [string, string][];
};

export function readManifest(): Record<string, Fixture> {
  return JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as Record<
    string,
    Fixture
  >;
}

/** What one run recorded: enough to compare it, find why it failed, and run it again. */
export type RunRecord = {
  fixture: string;
  kind: Fixture["kind"];
  label: string;
  run: number;
  model: string;
  promptVersion: string;
  /** The commit, and with `+changes.<hash>` what `apps/server` changed beyond it. */
  codeRevision: string;
  settings: { runs: number; concurrency: number };
  seconds: number;
  raw?: unknown;
  result?: unknown;
  counts?: unknown;
  checks?: unknown;
  error?: { name: string; failure: string | null; message: string };
};

/** A checkout's AI, assumed to have the shape of this one's. */
type CheckoutAi = typeof import("../../apps/server/ai/index.ts");
type Model = Parameters<CheckoutAi["draftCourse"]>[0];

/** The model a checkout's server uses unless `BRAIVO_AI_MODEL` says otherwise, read from its source, which does not export it. */
function defaultModel(checkout: string): string {
  const config = readFileSync(join(checkout, "apps/server/config.ts"), "utf8");
  const found = /const DEFAULT_MODEL = "([^"]+)"/.exec(config)?.[1];
  if (!found)
    throw new Error(`No DEFAULT_MODEL in ${checkout}'s apps/server/config.ts; pass --model.`);
  return found;
}

function revision(checkout: string): string {
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe" }).stdout.toString();
  const head = git("rev-parse", "--short=12", "HEAD").trim();
  if (!git("status", "--porcelain", "--", "apps/server").trim()) return head;
  // Uncommitted changes, tracked and new, so two dirty runs of different code differ.
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", "apps/server")
    .split("\0")
    .filter(Boolean);
  return `${head}+changes.${hash(
    git("diff", "HEAD", "--", "apps/server"),
    ...untracked.flatMap((file) => [file, readFileSync(join(checkout, file))]),
  )}`;
}

/**
 * Runs each fixture `runs` times with the checkout's code, at most
 * `concurrency` at once, writing each run to `out` as it settles.
 */
export async function runEvaluation(options: {
  checkout: string;
  label: string;
  fixtures: string[];
  runs: number;
  model: string;
  apiKey: string;
  out: string;
  concurrency?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): Promise<RunRecord[]> {
  const { checkout, label, runs, model, apiKey, out, concurrency = 3, log = console.log } = options;
  const ai = (await import(join(checkout, "apps/server/ai/index.ts"))) as CheckoutAi;
  const promptVersions = {
    draft: ai.promptVersion(ai.DRAFT_OPERATION),
    read: ai.promptVersion(ai.READ_OPERATION),
  };
  const codeRevision = revision(checkout);
  const manifest = readManifest();
  mkdirSync(out, { recursive: true });

  const jobs = options.fixtures.flatMap((fixture) =>
    Array.from({ length: runs }, (_, index) => ({ fixture, run: index + 1 })),
  );
  const records: RunRecord[] = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { fixture, run } = jobs[next++]!;
      const spec = manifest[fixture]!;
      const record: RunRecord = {
        fixture,
        kind: spec.kind,
        label,
        run,
        model,
        promptVersion: promptVersions[spec.kind],
        codeRevision,
        settings: { runs, concurrency },
        seconds: 0,
      };
      const real = ai.anthropicModel({ apiKey, model, fetch: options.fetch });
      const capturing: Model = {
        id: model,
        answer: async (request) => (record.raw = await real.answer(request)),
      };
      const started = Date.now();
      try {
        const bytes = readFileSync(join(FIXTURES, spec.file));
        if (spec.kind === "draft") {
          const material = bytes.toString("utf8").normalize("NFC");
          const { draft, counts } = await ai.draftCourse(
            capturing,
            { id: fixture, title: spec.title ?? fixture, text: material, language: spec.language },
            {
              goal: spec.goal,
              audience: spec.audience,
              instructionLanguage: spec.instructionLanguage,
            },
          );
          Object.assign(record, { result: draft, counts });
          record.checks = checkDraft({
            material,
            raw: record.raw,
            draft,
            offTopic: spec.offTopic,
            goalInMaterial: spec.goalInMaterial,
            outsideMaterial: spec.outsideMaterial,
            instructionLanguage: spec.instructionLanguage ?? spec.expectedInstructionLanguage,
            materialLanguage: spec.language,
          });
        } else {
          const { pages, counts } = await ai.extractPages(capturing, {
            mediaType: spec.mediaType!,
            bytes: new Uint8Array(bytes),
          });
          Object.assign(record, { result: pages, counts });
          record.checks = checkReading({ pages, lines: spec.lines, order: spec.order });
        }
      } catch (error) {
        const { name, message } = error instanceof Error ? error : new Error(String(error));
        const failure = (error as { failure?: unknown }).failure;
        record.error = { name, failure: typeof failure === "string" ? failure : null, message };
      }
      record.seconds = Math.round((Date.now() - started) / 1000);
      writeFileSync(join(out, `${fixture}-${run}.json`), `${JSON.stringify(record, null, 2)}\n`);
      records.push(record);
      log(
        `${fixture}#${run} ${record.error ? `FAILED ${record.error.failure ?? record.error.name}: ${record.error.message}` : summary(record)} (${record.seconds}s)`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return records;
}

function summary(record: RunRecord): string {
  const checks = record.checks as { failed: string[]; keptShare?: number; pages?: number };
  const head =
    record.kind === "draft"
      ? `kept ${Math.round(100 * checks.keptShare!)}%`
      : `${checks.pages} pages`;
  return checks.failed.length ? `${head}, ${checks.failed.length} check(s) failed` : head;
}

const USAGE = `Usage:
  bun run eval:draft [--checkout <dir>] [--label <name>] [--runs <n>] [--fixture <name>]... [--model <id>] [--yes]
      Draft or read each fixture <n> times (3) with <dir>'s code (this checkout's
      by default), recording every run under tmp/draft-eval/. Prints the number
      of model calls and spends none without --yes.
  bun run eval:draft compare <baseline run dir> <candidate run dir>
      Compare two runs fixture by fixture, and write the rubric to grade.`;

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "compare") {
    if (argv.length !== 3) {
      console.error(USAGE);
      return 1;
    }
    console.log(compareEvaluations(resolve(argv[1]!), resolve(argv[2]!)));
    return 0;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      checkout: { type: "string", default: "." },
      label: { type: "string" },
      runs: { type: "string", default: "3" },
      fixture: { type: "string", multiple: true },
      model: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const manifest = readManifest();
  const fixtures = values.fixture ?? Object.keys(manifest);
  const runs = Number(values.runs);
  const checkout = resolve(values.checkout);
  const unknown = fixtures.filter((name) => !(name in manifest));
  if (!Number.isInteger(runs) || runs < 1 || unknown.length > 0) {
    console.error(unknown.length ? `No such fixture: ${unknown.join(", ")}.` : USAGE);
    return 1;
  }
  if (!existsSync(join(checkout, "apps/server/ai/index.ts"))) {
    console.error(`${checkout} is not a Braivo checkout.`);
    return 1;
  }

  // The evaluated checkout's own default, so a change of default model is compared with the old one.
  const model = values.model ?? (process.env.BRAIVO_AI_MODEL || defaultModel(checkout));
  const calls = fixtures.length * runs;
  console.log(
    `${calls} calls of ${model} (${fixtures.length} fixtures × ${runs} runs) with ${checkout}'s code at ${revision(checkout)}.`,
  );
  if (!values.yes) {
    console.log("Nothing was asked. Add --yes to spend them.");
    return 0;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set (in .env.local, say).");
    return 1;
  }

  const label = values.label ?? revision(checkout);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve("tmp/draft-eval", `${stamp}-${label}`);
  const records = await runEvaluation({
    checkout,
    label,
    fixtures,
    runs,
    model,
    apiKey,
    out,
  });
  const failed = records.filter((record) => record.error).length;
  console.log(
    `\nRecorded in ${out}${failed ? `; ${failed} run(s) failed, recorded and excluded from means` : ""}.`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
