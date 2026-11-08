// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Compares two recorded runs of the draft evaluation: a table per fixture, a
// total over the fixtures both ran, failed runs apart (never in a mean), and a
// rubric sheet of sampled objectives for a person to grade. No verdict: a
// person reads it (README.md).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DraftChecks, ReadingChecks } from "./checks.ts";
import type { RunRecord } from "./eval.ts";

type Side = { name: string; dir: string; records: RunRecord[] };

function load(name: string, dir: string): Side {
  const records = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord)
    .sort((a, b) => a.fixture.localeCompare(b.fixture) || a.run - b.run);
  if (records.length === 0) throw new Error(`No runs recorded in ${dir}.`);
  return { name, dir, records };
}

const percent = (value: number) => `${Math.round(100 * value)}%`;
const ratio = (part: number, whole: number) =>
  `${part}/${whole}${whole ? ` (${percent(part / whole)})` : ""}`;

function spread(values: number[], show: (value: number) => string): string {
  if (values.length === 0) return "–";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const [low, high] = [Math.min(...values), Math.max(...values)];
  return low === high ? show(mean) : `${show(mean)} [${show(low)}–${show(high)}]`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const line = (row: string[]) =>
    `| ${row.map((cell, i) => cell.padEnd(widths[i]!)).join(" | ")} |`;
  return [
    line(rows[0]!),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.slice(1).map(line),
  ].join("\n");
}

function describe(side: Side): string {
  const versions = new Set(side.records.map((record) => `${record.kind} ${record.promptVersion}`));
  const first = side.records[0];
  return `${side.name}: ${first?.label} at ${first?.codeRevision}, ${first?.model}; ${[...versions].sort().join(", ")}`;
}

export function compareEvaluations(baselineDir: string, candidateDir: string): string {
  const sides = [load("baseline", baselineDir), load("candidate", candidateDir)];
  const fixtures = [
    ...new Set(sides.flatMap((side) => side.records.map((record) => record.fixture))),
  ].sort();
  const out: string[] = sides.map(describe);
  const shared = new Set(
    fixtures.filter((fixture) =>
      sides.every((side) => side.records.some((record) => record.fixture === fixture)),
    ),
  );
  for (const fixture of fixtures.filter((fixture) => !shared.has(fixture))) {
    const by = sides.find((side) => side.records.some((record) => record.fixture === fixture));
    out.push(`${fixture}: run by ${by!.name} only; left out of the totals.`);
  }

  const drafts = [
    [
      "Fixture",
      "Side",
      "Runs",
      "Failed",
      "Kept share",
      "Tasks kept",
      "Quotes ambiguous",
      "Refusal lines",
      "Checks failed",
    ],
  ];
  const readings = [["Fixture", "Side", "Runs", "Failed", "Pages", "Checks failed"]];
  const totals = [
    ["Side", "Objectives kept", "Tasks kept", "Items kept", "Quotes ambiguous", "Refusal lines"],
  ];
  const problems: string[] = [];
  const decoded: string[] = [];

  for (const side of sides) {
    let objectives = [0, 0];
    let tasks = [0, 0];
    let quotes = [0, 0];
    let refusals = 0;
    for (const fixture of fixtures) {
      const records = side.records.filter((record) => record.fixture === fixture);
      if (records.length === 0) continue;
      const ok = records.filter((record) => !record.error);
      for (const record of records) {
        if (record.error) {
          problems.push(
            `${side.name} ${fixture}#${record.run} failed: ${record.error.failure ?? record.error.name}: ${record.error.message}`,
          );
        }
        const checks = record.checks as { failed?: string[]; decoded?: boolean } | undefined;
        for (const failed of checks?.failed ?? []) {
          problems.push(`${side.name} ${fixture}#${record.run}: ${failed}`);
        }
        if (checks?.decoded) decoded.push(`${side.name} ${fixture}#${record.run}`);
      }
      const failedChecks = ok.filter(
        (record) => (record.checks as { failed: string[] }).failed.length > 0,
      ).length;
      const base = [fixture, side.name, String(records.length), String(records.length - ok.length)];
      if (records[0]!.kind === "draft") {
        const checks = ok.map((record) => record.checks as DraftChecks);
        const sum = (pick: (check: DraftChecks) => number) =>
          checks.reduce((total, check) => total + pick(check), 0);
        const fixtureQuotes = [
          sum((c) => c.quotes.ambiguous ?? 0),
          sum((c) => Object.values(c.quotes).reduce((a, b) => a + b, 0)),
        ];
        if (shared.has(fixture)) {
          objectives = [
            objectives[0]! + sum((c) => c.kept.objectives),
            objectives[1]! + sum((c) => c.proposed.objectives),
          ];
          tasks = [tasks[0]! + sum((c) => c.kept.tasks), tasks[1]! + sum((c) => c.proposed.tasks)];
          quotes = [quotes[0]! + fixtureQuotes[0]!, quotes[1]! + fixtureQuotes[1]!];
          refusals += sum((c) => c.refusalLines);
        }
        drafts.push([
          ...base,
          spread(
            checks.map((c) => c.keptShare),
            percent,
          ),
          `${sum((c) => c.kept.tasks)}/${sum((c) => c.proposed.tasks)}`,
          ratio(fixtureQuotes[0]!, fixtureQuotes[1]!),
          spread(
            checks.map((c) => c.refusalLines),
            (value) => value.toFixed(value % 1 ? 1 : 0),
          ),
          `${failedChecks} of ${ok.length}`,
        ]);
      } else {
        const checks = ok.map((record) => record.checks as ReadingChecks);
        readings.push([
          ...base,
          spread(
            checks.map((c) => c.pages),
            String,
          ),
          `${failedChecks} of ${ok.length}`,
        ]);
      }
    }
    if (objectives[1]! + tasks[1]! > 0) {
      totals.push([
        side.name,
        `${objectives[0]}/${objectives[1]}`,
        `${tasks[0]}/${tasks[1]}`,
        ratio(objectives[0]! + tasks[0]!, objectives[1]! + tasks[1]!),
        ratio(quotes[0]!, quotes[1]!),
        String(refusals),
      ]);
    }
  }

  if (drafts.length > 1)
    out.push(
      "",
      "Drafting, means over runs that did not fail [range]. Kept: passed Braivo's checks; not a judgement of quality, which is the rubric's.",
      "",
      table(drafts.sort(byFixture)),
    );
  if (totals.length > 1)
    out.push("", "Drafting in all, over the fixtures both sides ran:", "", table(totals));
  if (readings.length > 1) out.push("", "Reading:", "", table(readings.sort(byFixture)));
  out.push(
    "",
    problems.length
      ? `Failed runs and checks:\n${problems.map((line) => `- ${line}`).join("\n")}`
      : "No run or check failed.",
  );
  // Apart from the failures: decoded, these drafts count as answered, yet the
  // model did not keep to the shape asked for.
  if (decoded.length) {
    out.push(
      "",
      `Objectives sent as JSON text and decoded by Braivo:\n${decoded.map((line) => `- ${line}`).join("\n")}`,
    );
  }

  // One per comparison, beside the candidate's runs, named by what both sides
  // recorded (a folder's name says nothing of which runs it holds): another
  // baseline, or either side's runs changed, writes another; comparing the
  // same again never writes over one already graded.
  const comparison = createHash("sha256")
    .update(JSON.stringify(sides.map((side) => side.records)))
    .digest("hex")
    .slice(0, 12);
  const rubric = join(candidateDir, `rubric-vs-${basename(baselineDir)}-${comparison}.md`);
  if (existsSync(rubric)) {
    out.push("", `Rubric kept as it was: ${rubric}`);
  } else {
    writeFileSync(rubric, rubricSheet(sides, fixtures));
    out.push("", `Rubric to grade by hand: ${rubric}`);
  }
  return out.join("\n");
}

/** Keeps the header first, then groups each fixture's sides together. */
function byFixture(a: string[], b: string[]): number {
  if (a[0] === "Fixture") return -1;
  if (b[0] === "Fixture") return 1;
  return a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!);
}

const CHECKLIST = [
  "One assessable target per objective: a word or phrase, or one rule over several words, never words sharing only a topic",
  "Answering the task shows its objective's ability, not a neighbour's: understanding a reply is not asking",
  "The task's prompt and explanation are in the language asked for; its answer in the language the objective practises",
  "The keyed answer is right and supported by its quote (located is not supported)",
  "The explanation teaches the distinction tested",
  "Its feedback gives no other task's answer away",
  "No option depends on the options' order",
  "A typed task accepts every right answer",
];

type DraftTask = {
  kind: string;
  prompt: string;
  options?: string[];
  answer?: number;
  accepted?: string[];
  explanation?: string;
  citations: { quote: string }[];
};

/**
 * Up to three objectives per fixture and side, the first, middle, and last,
 * each from another run that did not fail, so later runs are graded too. Each
 * shows its first task to grade and its other tasks, to see what one gives
 * away of another; the run's file holds the whole draft.
 */
function rubricSheet(sides: Side[], fixtures: string[]): string {
  const lines = [
    "# Draft rubric",
    "",
    `Grade each task: tick what holds, note what does not. ${sides.map(describe).join(". ")}.`,
  ];
  const describeTask = (task: DraftTask) => [
    `${task.kind}: ${task.prompt}`,
    ...(task.options ?? []).map(
      (option, i) => `  - ${i === task.answer ? "**(correct)** " : ""}${option}`,
    ),
    ...(task.accepted ? [`  - Accepted: ${task.accepted.join(" / ")}`] : []),
    ...(task.explanation ? [`  - Explanation: ${task.explanation}`] : []),
    `  - Quotes: ${task.citations.map(({ quote }) => `“${quote}”`).join("; ")}`,
  ];
  for (const fixture of fixtures) {
    for (const side of sides) {
      const records = side.records.filter(
        (r) => r.fixture === fixture && r.kind === "draft" && !r.error,
      );
      if (records.length === 0) continue;
      lines.push("", `## ${fixture}, ${side.name}`);
      (["first", "middle", "last"] as const).forEach((position, i) => {
        const record = records[i % records.length]!;
        const { objectives } = record.result as {
          objectives: { title: string; tasks: DraftTask[] }[];
        };
        const index = {
          first: 0,
          middle: Math.floor(objectives.length / 2),
          last: objectives.length - 1,
        }[position];
        const objective = objectives[index];
        if (!objective?.tasks[0]) return;
        const [task, ...others] = objective.tasks;
        lines.push(
          "",
          `### ${objective.title}`,
          "",
          `Run ${record.run}, its ${position} of ${objectives.length} objectives; the whole draft: ${join(side.dir, `${fixture}-${record.run}.json`)}`,
          "",
          ...describeTask(task!).map((line) => line.replace(/^ {2}/, "")),
          "",
          ...CHECKLIST.map((item) => `- [ ] ${item}`),
        );
        if (others.length) {
          lines.push(
            "",
            "Its other tasks:",
            "",
            ...others.flatMap((other) =>
              describeTask(other).map((line, j) => (j ? line : `- ${line}`)),
            ),
          );
        }
      });
    }
  }
  return `${lines.join("\n")}\n`;
}
