// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a task asks and how it is graded, one variant per kind. Stored whole as
 * JSON beside the task's relational columns, so adding a kind is a new variant
 * here rather than a column that is null for every other kind.
 *
 * `choice` is the first kind because its grading is deterministic: the loop
 * closes without AI, and an AI-graded kind later adds a variant, not a path.
 */
export type TaskBody = {
  kind: "choice";
  prompt: string;
  options: string[];
  /** Index into `options` of the one correct option. */
  answer: number;
  /** Shown after grading, whatever the outcome: why the answer is the answer. */
  explanation?: string;
  /**
   * Present the options in the order written, for options whose order means
   * something: "all of the above", a scale. Otherwise they are shuffled.
   */
  keepOrder?: true;
};

/**
 * A task as a learner may see it before answering: no answer, no explanation.
 * Each option carries its `choice`, so a client never maps a display position
 * to an answer.
 */
export type PresentedTask = {
  kind: "choice";
  prompt: string;
  options: { choice: number; text: string }[];
};

/** A learner's answer to a task, shaped by its kind: `choice` is the option's, not its position. */
export type TaskResponse = { choice: number };

/**
 * The grader's verdict on one response, and what the learner sees after
 * answering. `outcome` becomes evidence; the rest is feedback.
 */
export type Grade = {
  outcome: "success" | "failure";
  answer: number;
  explanation?: string;
};

/** More options than anyone reads through. Bounds their number, not their length. */
const MAX_OPTIONS = 26;

/**
 * Reads a task body, or nothing when it is not a valid one. Checked on the way
 * in because a task is immutable: a broken answer key cannot be fixed later,
 * only replaced.
 */
export function parseTaskBody(value: unknown): TaskBody | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const { kind, prompt, options, answer, explanation, keepOrder } = value as Record<
    string,
    unknown
  >;
  if (kind !== "choice") return undefined;
  if (!isText(prompt)) return undefined;
  if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
    return undefined;
  }
  if (!options.every(isText)) return undefined;
  // Two identical options would make "which one" unanswerable from the text.
  if (new Set(options.map((option) => option.trim())).size !== options.length) return undefined;
  if (!Number.isInteger(answer) || (answer as number) < 0 || (answer as number) >= options.length) {
    return undefined;
  }
  if (explanation !== undefined && !isText(explanation)) return undefined;
  if (keepOrder !== undefined && typeof keepOrder !== "boolean") return undefined;

  return {
    kind,
    prompt: prompt.trim(),
    options: options.map((option) => option.trim()),
    answer: answer as number,
    ...(explanation === undefined ? {} : { explanation: explanation.trim() }),
    ...(keepOrder === true ? { keepOrder } : {}),
  };
}

/**
 * What a learner sees before answering. Built by listing fields, never by
 * removing them.
 *
 * Options are shuffled by `seed` unless the author kept their order. One seed,
 * one order: the caller picks a seed that changes exactly when the order
 * should. A new seed may still give the same order (half the time with two).
 */
export function presentTask(body: TaskBody, seed: string): PresentedTask {
  const options = body.options.map((text, choice) => ({ choice, text }));
  return {
    kind: body.kind,
    prompt: body.prompt,
    options: body.keepOrder ? options : shuffled(options, seed),
  };
}

/** Reads a learner's response to this task, or nothing when it cannot be one. */
export function parseTaskResponse(body: TaskBody, value: unknown): TaskResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const { choice } = value as Record<string, unknown>;
  if (!Number.isInteger(choice)) return undefined;
  if ((choice as number) < 0 || (choice as number) >= body.options.length) return undefined;

  // `-0` passes as option 0 but is stored as `0`, and a retry comparing the two
  // would then conflict with itself.
  return { choice: choice === 0 ? 0 : (choice as number) };
}

/** Grades a response. Deterministic, so a retried attempt grades the same. */
export function gradeResponse(body: TaskBody, response: TaskResponse): Grade {
  return {
    outcome: response.choice === body.answer ? "success" : "failure",
    answer: body.answer,
    ...(body.explanation === undefined ? {} : { explanation: body.explanation }),
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

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
