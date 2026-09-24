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
};

/** A task as a learner may see it before answering: no answer, no explanation. */
export type PresentedTask = { kind: "choice"; prompt: string; options: string[] };

/** A learner's answer to a task, shaped by its kind. */
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

  const { kind, prompt, options, answer, explanation } = value as Record<string, unknown>;
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

  return {
    kind,
    prompt: prompt.trim(),
    options: options.map((option) => option.trim()),
    answer: answer as number,
    ...(explanation === undefined ? {} : { explanation: explanation.trim() }),
  };
}

/** What a learner sees before answering. Built by listing fields, never by removing them. */
export function presentTask(body: TaskBody): PresentedTask {
  return { kind: body.kind, prompt: body.prompt, options: body.options };
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

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
