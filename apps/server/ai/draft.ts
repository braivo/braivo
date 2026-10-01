// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import * as z from "zod";

import {
  isStorableText,
  locateQuote,
  MAX_TITLE,
  parseTaskBody,
  QUOTE_REFUSALS,
  type TaskBody,
} from "../content/index.ts";
import { type Model, ModelUnavailable } from "./model.ts";

/** A quote as the authoring endpoints take it, so an accepted draft is sent as it is. */
export type DraftQuote = { sourceId: string; quote: string };

/**
 * A course drafted from one source, in the shapes the authoring endpoints
 * take: objectives with keys, their citations, their tasks — and what was
 * refused, named, since a reviewer should know what the model got wrong
 * (docs/adr/0029-server-drafting.md). Nothing in it is stored.
 */
export type Draft = {
  objectives: {
    /**
     * Random, made for this draft: accepting it again — a retry after a
     * failure — finds the objectives it already made, and another draft makes
     * its own.
     */
    key: string;
    title: string;
    citations: DraftQuote[];
    tasks: (TaskBody & { citations: DraftQuote[] })[];
  }[];
  refused: string[];
};

/** Enough for a unit's worth of material; a larger one is several sources. */
const MAX_OBJECTIVES = 12;
const MAX_TASKS = 5;

/**
 * Quotes read per task and per objective: few, since a question is written
 * from a passage or two, and so that accepting a whole draft is never refused
 * for its size. It is sent as one task request of at most 12 × 5 × 3 = 180
 * quotes and one citation request of at most 12 × 5 = 60, each within the 200
 * one authoring request may ask Braivo to find.
 */
const MAX_TASK_CITATIONS = 3;
const MAX_OBJECTIVE_CITATIONS = 5;

/** What the model is asked to answer, and the only shape Braivo reads from it. */
const Answer = z.object({
  objectives: z
    .array(
      z.object({
        title: z.string().describe("What a learner can do once they have learnt it."),
        quotes: z
          .array(z.string())
          .describe(
            `The material's exact words that teach it, at most ${MAX_OBJECTIVE_CITATIONS}.`,
          ),
        tasks: z.array(
          z.object({
            prompt: z.string(),
            options: z.array(z.string()),
            answer: z.number().int().describe("Index into options of the one correct option."),
            explanation: z.string().optional().describe("Why the answer is right."),
            quotes: z
              .array(z.string())
              .describe(
                `The material's exact words it was written from, at most ${MAX_TASK_CITATIONS}.`,
              ),
          }),
        ),
      }),
    )
    .describe("In the order learners should meet them."),
});

const SYSTEM = `You turn a teacher's material into a course for Braivo, an adaptive tutor.

Objectives are what the material teaches: stable, assessable learning targets, one skill or piece of knowledge each, at most ${MAX_OBJECTIVES}, in the order learners should meet them. Each has a title and quotes: the material's words that teach it.

For each objective, write 2 to ${MAX_TASKS} multiple-choice tasks: a short prompt, 2 to 4 options with exactly one correct, plausible wrong options, the index of the correct one, and an explanation of why it is right. Each task quotes the words it was written from. Write for the learners described, in their language, about what the material teaches.

Every quote is copied exactly from the material, a sentence or a line, and must occur only once in it: Braivo checks each one, and drops what it cannot find. Teach only what the material teaches.`;

/**
 * Drafts a course from one source with `model`, keeping only what Braivo would
 * accept, and only what traces to the source: a quote not found once in it, a
 * task that is not valid or has no quote left, and an objective with no quote
 * or no task left are refused and named instead.
 */
export async function draftCourse(
  model: Model,
  source: { id: string; title: string; text: string; language?: string },
  options: { audience?: string; signal?: AbortSignal } = {},
): Promise<Draft> {
  const answered = await model.answer({
    system: SYSTEM,
    prompt: [
      `Learners: ${options.audience ?? "young learners at school"}.`,
      `Material: "${source.title}"${source.language ? `, in ${source.language}` : ""}.`,
      "",
      "<material>",
      source.text,
      "</material>",
    ].join("\n"),
    name: "draft_course",
    description: "Proposes the course: its objectives, each with its quotes and tasks.",
    schema: z.toJSONSchema(Answer),
    signal: options.signal,
  });
  const parsed = Answer.safeParse(answered);
  if (!parsed.success)
    throw new ModelUnavailable("The model answered without the shape asked for.");

  const refused: string[] = [];
  // Only the first `limit` quotes are looked for: each is a scan of the source,
  // and the model's answer is not what bounds how many it sends.
  const cite = (quotes: string[], where: string, limit: number): DraftQuote[] => {
    if (quotes.length > limit) refused.push(`${where}: only its first ${limit} quotes are read.`);
    return quotes.slice(0, limit).flatMap((quote, index) => {
      const location = locateQuote(source.text, quote);
      if (location.kind === "located") return [{ sourceId: source.id, quote }];
      refused.push(`${where}, quote ${index}: the quote ${QUOTE_REFUSALS[location.kind]}.`);
      return [];
    });
  };

  const objectives: Draft["objectives"] = [];
  for (const [index, objective] of parsed.data.objectives.entries()) {
    const where = `Objective ${index}`;
    if (index >= MAX_OBJECTIVES) {
      refused.push(`${where}: more than ${MAX_OBJECTIVES} objectives were drafted.`);
      continue;
    }
    if (!isStorableText(objective.title, MAX_TITLE)) {
      refused.push(`${where}: its title is blank or over ${MAX_TITLE} characters.`);
      continue;
    }
    const title = objective.title.trim();

    const tasks: Draft["objectives"][number]["tasks"] = [];
    for (const [taskIndex, task] of objective.tasks.entries()) {
      const at = `${where}, task ${taskIndex}`;
      if (taskIndex >= MAX_TASKS) {
        refused.push(`${at}: more than ${MAX_TASKS} tasks were drafted.`);
        continue;
      }
      const { quotes, explanation, ...fields } = task;
      // A blank explanation is no explanation, not a reason to lose the task.
      const body = parseTaskBody({
        kind: "choice",
        ...fields,
        ...(explanation?.trim() ? { explanation } : {}),
      });
      if ("problem" in body) {
        refused.push(`${at}: the task ${body.problem}.`);
        continue;
      }
      const citations = cite(quotes, at, MAX_TASK_CITATIONS);
      // Braivo's own writing is held to more than a person's: what it drafts
      // traces to the source, or it is not proposed (ADR 0029).
      if (citations.length === 0) {
        refused.push(`${at}: none of its quotes was found in the source.`);
        continue;
      }
      tasks.push({ ...body.body, citations });
    }

    const citations = cite(objective.quotes, where, MAX_OBJECTIVE_CITATIONS);
    if (citations.length === 0 || tasks.length === 0) {
      refused.push(
        `${where}: ${citations.length === 0 ? "none of its quotes was found in the source" : "none of its tasks was kept"}.`,
      );
      continue;
    }
    objectives.push({ key: crypto.randomUUID(), title, citations, tasks });
  }

  return { objectives, refused };
}
