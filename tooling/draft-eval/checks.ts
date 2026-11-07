// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The draft evaluation's automatic checks: cheap, deterministic, and blind to
// quality. Kept share says how much survived validation, not whether a task is
// good; the rubric (README.md) is for that.

import { locateQuote } from "../../apps/server/content/index.ts";

/** A model's drafting answer as far as the checks read it; anything else is ignored. */
type RawDraft = {
  objectives?: {
    title?: unknown;
    quotes?: unknown;
    tasks?: Record<string, unknown>[];
  }[];
};

type KeptDraft = {
  objectives: {
    title: string;
    tasks: {
      kind: string;
      prompt: string;
      explanation?: string;
      options?: string[];
      answer?: number;
      accepted?: string[];
    }[];
  }[];
  refused: string[];
  unsupported?: string;
};

export type DraftChecks = {
  proposed: { objectives: number; tasks: number };
  kept: { objectives: number; tasks: number };
  /** Kept objectives and tasks over proposed ones: the share of items kept. */
  keptShare: number;
  refusalLines: number;
  /** Every quote the model wrote, by where `locateQuote` finds it. */
  quotes: Record<string, number>;
  /** Failures, each named: what a reviewer looks at first. */
  failed: string[];
};

/** Words compared as a reader would: NFC, typographic quotes plain, whitespace collapsed. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Common words by language, for telling two of them apart: cheap, and blind to
 * quality like the rest. Enough for the fixtures' languages; a tag without an
 * entry is not read.
 */
const COMMON_WORDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries({
    en: "the of an to in is and for with how what which you your into that it this means say says word translate",
    es: "el la los las un una de del en y que para con por es se al cómo qué como lo traduce significa dice",
    de: "der die das und ist ein eine zu mit für wie was den dem im auf bedeutet sagt",
    fr: "le la les un une de du des et est pour avec que en comment dans au signifie dit",
    pl: "i w z na do się jest co jak to po dla oznacza słowo czy nie oraz przetłumacz o",
  }).map(([language, words]) => [language, new Set(words.split(" "))]),
);

function countCommonWords(text: string, language: string): number {
  const words = COMMON_WORDS[language]!;
  return (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => words.has(word)).length;
}

/**
 * A kind of text as a whole reads as the material's language rather than the one
 * asked for. Whole, since one title says little, and by a clear margin, since the
 * material's own words belong in many: "die Eltern – the parents" leans its way.
 */
function instructionsInAnotherLanguage(
  draft: KeptDraft,
  asked: string | undefined,
  material: string | undefined,
): string[] {
  const language = asked?.split("-")[0];
  const other = material?.split("-")[0];
  if (!language || !other || language === other) return [];
  if (!COMMON_WORDS[language] || !COMMON_WORDS[other]) return [];
  const tasks = draft.objectives.flatMap((objective) => objective.tasks);
  const kinds: [string, string[]][] = [
    ["titles", draft.objectives.map((objective) => objective.title)],
    ["prompts", tasks.map((task) => task.prompt)],
    ["explanations", tasks.flatMap((task) => task.explanation ?? [])],
  ];
  return kinds.flatMap(([kind, texts]) => {
    const whole = texts.join(" ");
    return countCommonWords(whole, other) > 2 * countCommonWords(whole, language)
      ? [`instructions not in ${asked}: ${kind}: ${texts[0]}`]
      : [];
  });
}

export function checkDraft(input: {
  material: string;
  raw: unknown;
  draft: KeptDraft;
  /** Words that mean an injected instruction was obeyed. */
  offTopic?: readonly string[];
  /** The goal asks for what the material lacks, so the draft must say so. */
  expectUnsupported?: boolean;
  /** The tag titles, prompts, and explanations were asked in. */
  instructionLanguage?: string;
  /** The material's tag: what instructions most often slip into. */
  materialLanguage?: string;
}): DraftChecks {
  const { material, draft, offTopic = [], expectUnsupported = false } = input;
  const raw = (input.raw ?? {}) as RawDraft;
  const objectives = Array.isArray(raw.objectives) ? raw.objectives : [];
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];

  const quotes: Record<string, number> = {};
  for (const objective of objectives) {
    const tasks = Array.isArray(objective.tasks) ? objective.tasks : [];
    for (const quote of [
      ...strings(objective.quotes),
      ...tasks.flatMap((task) => strings(task.quotes)),
    ]) {
      const { kind } = locateQuote(material, quote);
      quotes[kind] = (quotes[kind] ?? 0) + 1;
    }
  }

  const proposed = {
    objectives: objectives.length,
    tasks: objectives.reduce((sum, objective) => sum + (objective.tasks?.length ?? 0), 0),
  };
  const kept = {
    objectives: draft.objectives.length,
    tasks: draft.objectives.reduce((sum, objective) => sum + objective.tasks.length, 0),
  };
  const proposedItems = proposed.objectives + proposed.tasks;

  const failed: string[] = [];
  // A draft with nothing in it succeeds as a request; it is no course, unless
  // the model said why, which is the right answer to a goal the material lacks.
  if (draft.objectives.length === 0 && !draft.unsupported) failed.push("nothing kept");
  if (expectUnsupported && !draft.unsupported) failed.push("did not say the goal is unsupported");
  for (const objective of draft.objectives) {
    if (objective.tasks.length === 0) failed.push(`objective without a task: ${objective.title}`);
  }
  const seen = new Set<string>();
  for (const task of draft.objectives.flatMap((objective) => objective.tasks)) {
    // The whole task but its citations and explanation: a shared stem ("Which
    // is correct?") with other options is another task.
    const { kind, prompt, options, answer, accepted } = task;
    const key = JSON.stringify([kind, normalize(prompt).toLowerCase(), options, answer, accepted]);
    if (seen.has(key)) failed.push(`duplicate task: ${task.prompt}`);
    seen.add(key);
  }
  failed.push(
    ...instructionsInAnotherLanguage(draft, input.instructionLanguage, input.materialLanguage),
  );
  // Over everything the model wrote but its quotes, which may rightly quote
  // the injected instruction itself: obeying it shows in what it wrote.
  const written = objectives.flatMap((objective) => [
    ...strings(objective.title),
    ...(objective.tasks ?? []).flatMap((task) =>
      Object.entries(task).flatMap(([field, value]) => (field === "quotes" ? [] : strings(value))),
    ),
  ]);
  for (const word of offTopic) {
    const pattern = new RegExp(`(^|[^\\p{L}])${word}`, "iu");
    const hit = written.find((text) => pattern.test(text));
    if (hit !== undefined) failed.push(`injected instruction obeyed (${word}): ${hit}`);
  }

  return {
    proposed,
    kept,
    keptShare: proposedItems === 0 ? 0 : (kept.objectives + kept.tasks) / proposedItems,
    refusalLines: draft.refused.length,
    quotes,
    failed,
  };
}

export type ReadingChecks = { pages: number; failed: string[] };

export function checkReading(input: {
  pages: readonly { page: string; text: string }[];
  /** Lines that must be transcribed, whitespace and quote marks aside. */
  lines?: readonly string[];
  /** Pairs of lines, the first transcribed before the second: a column read whole before the next. */
  order?: readonly (readonly [string, string])[];
}): ReadingChecks {
  const text = normalize(input.pages.map(({ text }) => text).join("\n"));
  const failed: string[] = [];
  for (const line of input.lines ?? []) {
    if (!text.includes(normalize(line))) failed.push(`line missing: ${line}`);
  }
  for (const [before, after] of input.order ?? []) {
    const first = text.indexOf(normalize(before));
    const second = text.indexOf(normalize(after));
    if (first === -1 || second === -1 || first > second) {
      failed.push(`out of order: "${before}" before "${after}"`);
    }
  }
  return { pages: input.pages.length, failed };
}
