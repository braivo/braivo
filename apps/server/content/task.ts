// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { MAX_ACCEPTED, normalizeAnswer } from "./answer.ts";
import { parseLanguageTag } from "./source.ts";
import { isStorable, isStorableText } from "./text.ts";

/**
 * What a task asks and how it is graded, one variant per kind. Stored whole as
 * JSON beside the task's relational columns, so adding a kind is a new variant
 * here rather than a column that is null for every other kind.
 *
 * Every kind here grades deterministically, so the loop runs without AI; an
 * AI-graded kind would add a variant, not a path (docs/adr/0038-typed-answers.md).
 */
export type TaskBody = ChoiceBody | TypedBody;

/** Picking the one correct option: recognition. */
export type ChoiceBody = {
  kind: "choice";
  prompt: string;
  options: string[];
  /** Index into `options` of the one correct option. */
  answer: number;
  /** Shown after grading, whatever the outcome: why the answer is the answer. */
  explanation?: string;
  /**
   * Present the options in the order written, for options whose order means
   * something: a scale, "all of the above". Otherwise they are shuffled.
   */
  keepOrder?: true;
};

/** Typing the answer: recall, graded against the answers the author accepts. */
export type TypedBody = {
  kind: "typed";
  prompt: string;
  /** Every answer graded correct, compared as `normalizeAnswer` (`answer.ts`) writes them; the first is shown to a learner who missed. */
  accepted: string[];
  /** Shown after grading, whatever the outcome. */
  explanation?: string;
  /** The language the answers are in, canonical BCP 47: what a voice would speak. */
  answerLanguage?: string;
};

/**
 * A task as a learner may see it before answering: no answer, no explanation.
 * Each option carries its `choice`, so a client never maps a display position
 * to an answer.
 */
export type PresentedTask =
  | { kind: "choice"; prompt: string; options: { choice: number; text: string }[] }
  | { kind: "typed"; prompt: string };

/**
 * A learner's answer: an option's `choice` (not its position) to a choice
 * task, the `text` typed to a typed one, or, to either, asking to be shown the
 * answer, which grades as a failure.
 */
export type TaskResponse = { choice: number } | { text: string } | { reveal: true };

/**
 * The grader's verdict on one response, and what the learner sees after
 * answering. `outcome` becomes evidence; the rest is feedback.
 */
export type Grade =
  | {
      kind: "choice";
      outcome: "success" | "failure";
      /** The correct option's `choice`. Not `answer`, which invites indexing the presented options. */
      correctChoice: number;
      explanation?: string;
    }
  | {
      kind: "typed";
      outcome: "success" | "failure";
      /** The first accepted answer, whichever matched. Named as `correctChoice` is. */
      correctAnswer: string;
      explanation?: string;
    };

/** More options than anyone reads through. */
const MAX_OPTIONS = 26;

/** Longer than any question, option, or explanation a learner reads. */
const MAX_TEXT = 2000;

/** A word, a phrase, a date, a name: never a paragraph. */
const MAX_ACCEPTED_TEXT = 200;

/** What a learner may type, generous over the longest accepted answer. */
const MAX_TYPED = 500;

/**
 * Reads a task body, or says what is wrong with it. Checked on the way in
 * because a task is immutable: a broken answer key cannot be fixed later, only
 * replaced.
 *
 * `problem` finishes the sentence "The task …", and says what would fix it:
 * its reader is often a model drafting tasks from a source, which can correct
 * a mistake it is told about and cannot one it is not (docs/adr/0021-citations.md).
 * It names options by position and never repeats what was sent, which may be as
 * long as the request allows and would crowd that model's context.
 */
export function parseTaskBody(value: unknown): { body: TaskBody } | { problem: string } {
  if (typeof value !== "object" || value === null) return { problem: "is not a task" };

  const { kind } = value as Record<string, unknown>;
  if (kind === "choice") return parseChoiceBody(value as Record<string, unknown>);
  if (kind === "typed") return parseTypedBody(value as Record<string, unknown>);
  return { problem: 'has an unknown kind; the kinds are "choice" and "typed"' };
}

function parseChoiceBody(value: Record<string, unknown>): { body: TaskBody } | { problem: string } {
  const { prompt, options, answer, explanation, keepOrder } = value;
  if (!isText(prompt)) return { problem: `has a prompt that is ${textProblem(prompt)}` };
  if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
    return { problem: `needs 2 to ${MAX_OPTIONS} options` };
  }
  const invalid = options.findIndex((option) => !isText(option));
  if (invalid !== -1) {
    return { problem: `has option ${invalid} that is ${textProblem(options[invalid])}` };
  }
  // Options equal but for spacing or Unicode form (NFC "ż", or "z" and a combining dot)
  // would read the same, leaving "which one" unanswerable. Stored collapsed, in
  // the Unicode form sent.
  const collapsed = options.map(collapseWhitespace);
  const compared = collapsed.map((option) => option.normalize("NFC"));
  const repeat = compared.findIndex((option, index) => compared.indexOf(option) !== index);
  if (repeat !== -1) {
    const first = compared.indexOf(compared[repeat]!);
    return { problem: `repeats option ${first} as option ${repeat}; every option must differ` };
  }
  if (!Number.isInteger(answer) || (answer as number) < 0 || (answer as number) >= options.length) {
    return {
      problem: `needs its answer to be the index of the correct option, a whole number from 0 to ${options.length - 1}`,
    };
  }
  const explained = explanationProblem(explanation);
  if (explained) return { problem: explained };
  if (keepOrder !== undefined && typeof keepOrder !== "boolean") {
    return { problem: "has a keepOrder that is not true or false" };
  }

  return {
    body: {
      kind: "choice",
      prompt: collapseWhitespace(prompt),
      options: collapsed,
      answer: answer as number,
      ...(explanation === undefined ? {} : { explanation: (explanation as string).trim() }),
      ...(keepOrder === true ? { keepOrder } : {}),
    },
  };
}

function parseTypedBody(value: Record<string, unknown>): { body: TaskBody } | { problem: string } {
  const { prompt, accepted, explanation, answerLanguage } = value;
  if (!isText(prompt)) return { problem: `has a prompt that is ${textProblem(prompt)}` };
  if (!Array.isArray(accepted) || accepted.length < 1 || accepted.length > MAX_ACCEPTED) {
    return { problem: `needs 1 to ${MAX_ACCEPTED} accepted answers` };
  }
  const invalid = accepted.findIndex((answer) => !isStorableText(answer, MAX_ACCEPTED_TEXT));
  if (invalid !== -1) {
    return {
      problem: `has accepted answer ${invalid} that is ${textProblem(accepted[invalid], MAX_ACCEPTED_TEXT)}`,
    };
  }
  // Two answers equal as compared would be one answer listed twice.
  const compared = accepted.map((answer: string) => normalizeAnswer(answer));
  const repeat = compared.findIndex((answer, index) => compared.indexOf(answer) !== index);
  if (repeat !== -1) {
    const first = compared.indexOf(compared[repeat]!);
    return {
      problem: `repeats accepted answer ${first} as accepted answer ${repeat}, as answers are compared (case, spacing, and curly or straight quotes aside); list each once`,
    };
  }
  const explained = explanationProblem(explanation);
  if (explained) return { problem: explained };
  const language =
    answerLanguage === undefined
      ? undefined
      : typeof answerLanguage === "string"
        ? parseLanguageTag(answerLanguage)
        : undefined;
  if (answerLanguage !== undefined && language === undefined) {
    return { problem: 'has an answerLanguage that is not a language tag, such as "en" or "pt-BR"' };
  }

  return {
    body: {
      kind: "typed",
      prompt: collapseWhitespace(prompt),
      accepted: accepted.map((answer: string) => collapseWhitespace(answer)),
      ...(explanation === undefined ? {} : { explanation: (explanation as string).trim() }),
      ...(language === undefined ? {} : { answerLanguage: language }),
    },
  };
}

/** Why an explanation cannot be stored, finishing "The task …", or nothing when it can. */
function explanationProblem(explanation: unknown): string | undefined {
  if (explanation === undefined || isText(explanation)) return undefined;
  const problem = textProblem(explanation);
  return `has an explanation that is ${problem}${problem === "blank" ? "; leave a blank one out" : ""}`;
}

/**
 * What a learner sees before answering. Built by listing fields, never by
 * removing them.
 *
 * Options are shuffled by `seed` unless the author kept their order. One seed,
 * one order: the caller reseeds when a new asking begins, and a new seed may
 * still give the same order (half the time with two).
 */
export function presentTask(body: TaskBody, seed: string): PresentedTask {
  if (body.kind === "typed") return { kind: "typed", prompt: body.prompt };
  const options = body.options.map((text, choice) => ({ choice, text }));
  return {
    kind: body.kind,
    prompt: body.prompt,
    options: body.keepOrder ? options : shuffled(options, seed),
  };
}

/**
 * Reads a learner's response to this task, or nothing when it cannot be one.
 * It names exactly one of `choice`, `text`, and `reveal`: a mix is refused,
 * never read as whichever field is looked at first.
 */
export function parseTaskResponse(body: TaskBody, value: unknown): TaskResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const named = RESPONSE_FIELDS.filter((field) => Object.hasOwn(value, field));
  if (named.length !== 1) return undefined;
  const { choice, text, reveal } = value as Record<string, unknown>;
  if (named[0] === "reveal") return reveal === true ? { reveal } : undefined;
  if (body.kind === "typed") {
    // Stored exactly as sent: an empty one is an answer, and a failure.
    return typeof text === "string" && text.length <= MAX_TYPED && isStorable(text)
      ? { text }
      : undefined;
  }

  if (!Number.isInteger(choice)) return undefined;
  if ((choice as number) < 0 || (choice as number) >= body.options.length) return undefined;

  // `-0` passes as option 0 but is stored as `0`, and a retry comparing the two
  // would then conflict with itself.
  return { choice: choice === 0 ? 0 : (choice as number) };
}

const RESPONSE_FIELDS = ["choice", "text", "reveal"] as const;

/**
 * Grades a response `parseTaskResponse` read for this task. Deterministic; a
 * reveal is a failure, whatever the kind.
 */
export function gradeResponse(body: TaskBody, response: TaskResponse): Grade {
  const explanation = body.explanation === undefined ? {} : { explanation: body.explanation };
  if (body.kind === "choice") {
    const chosen = "choice" in response && response.choice === body.answer;
    return {
      kind: "choice",
      outcome: chosen ? "success" : "failure",
      correctChoice: body.answer,
      ...explanation,
    };
  }
  const typed =
    "text" in response &&
    body.accepted.some((answer) => normalizeAnswer(answer) === normalizeAnswer(response.text));
  return {
    kind: "typed",
    outcome: typed ? "success" : "failure",
    correctAnswer: body.accepted[0]!,
    ...explanation,
  };
}

/** Fisher–Yates over a copy, drawing from a generator seeded by `seed`. */
function shuffled<T>(items: readonly T[], seed: string): T[] {
  const random = mulberry32(fnv1a(seed));
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** A 32-bit FNV-1a hash of a string's UTF-16 code units: a seed, not a digest. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32: a small, fast generator of numbers in [0, 1). Presentation only, never security. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Trimmed, each run of spaces, tabs, and line breaks one space, as a page
 * collapses them: options differing only there would read the same yet grade
 * differently. A no-break space inside stays.
 */
function collapseWhitespace(text: string): string {
  return text.trim().replace(/[\t\n\r ]+/g, " ");
}

function isText(value: unknown): value is string {
  return isStorableText(value, MAX_TEXT);
}

/** Why `value`, refused by `isStorableText`, is not a task's text, finishing "… that is". */
function textProblem(value: unknown, max = MAX_TEXT): string {
  if (value === undefined) return "missing";
  if (typeof value !== "string") return "not text";
  const { length } = value.trim();
  if (length === 0) return "blank";
  if (length > max) return `over ${max} characters`;
  return "not storable: it carries a NUL or an unpaired surrogate";
}
