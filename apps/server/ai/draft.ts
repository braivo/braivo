// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import * as z from "zod";

import {
  isStorableText,
  locateQuote,
  MAX_TITLE,
  parseLanguageTag,
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

/**
 * A drafted text as `refused` names it: the owner reviews only what was kept,
 * numbered anew, so the model's positions would point nowhere. Cut short, as
 * an over-long title is one reason to refuse it.
 */
function named(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/g, " "));
  const shown = characters.length > 80 ? [...characters.slice(0, 79), "…"] : characters;
  return `“${shown.join("")}”`;
}

/**
 * An optional field of the model's answer, read as absent if malformed, such
 * as a stray null: it costs at most its task, never the whole draft. The JSON
 * Schema the model sees is unchanged.
 */
const lenient = <T extends z.ZodType>(field: T) => field.optional().catch(undefined);

/** What the model is asked to answer, and the only shape Braivo reads from it. */
const Answer = z.object({
  objectives: z
    .array(
      z.object({
        title: z.string().describe("What a learner can do once they have learnt it."),
        quotes: z
          .array(z.string())
          .describe(
            `The material's exact words that teach it, at most ${MAX_OBJECTIVE_CITATIONS}, each occurring exactly once in the material.`,
          ),
        tasks: z.array(
          // One shape for both kinds: a union is harder for a model to fill,
          // and Braivo checks each task by its kind anyway.
          z.object({
            kind: z.enum(["choice", "typed"]),
            prompt: z.string(),
            options: lenient(z.array(z.string())).describe("Multiple choice only."),
            answer: lenient(z.number().int()).describe(
              "Multiple choice only: index into options of the one correct option.",
            ),
            accepted: lenient(z.array(z.string())).describe(
              "Typed only: every answer to grade correct, the most usual first.",
            ),
            answerLanguage: lenient(z.string()).describe(
              'Typed only: the answers\' language, a BCP 47 tag such as "es" or "pt-BR".',
            ),
            explanation: lenient(z.string()).describe("Why the answer is right."),
            quotes: z
              .array(z.string())
              .describe(
                `The material's exact words it was written from, at most ${MAX_TASK_CITATIONS}, each occurring exactly once in the material.`,
              ),
          }),
        ),
      }),
    )
    .describe("In the order learners should meet them."),
});

const SYSTEM = `You turn a teacher's material into a course for Braivo, an adaptive tutor.

Objectives are what the material teaches: stable, assessable learning targets, one skill or piece of knowledge each, at most ${MAX_OBJECTIVES}, in the order learners should meet them. Each has a title and quotes: the material's words that teach it.

For each objective, write 2 to ${MAX_TASKS} tasks, each with an explanation of why its answer is right and the words it was written from as quotes. Two kinds:
- choice: a short prompt, 2 to 4 options with exactly one correct, plausible wrong options, and the index of the correct one.
- typed: the learner types a word or a short phrase from memory, never a sentence, for what is worth recalling rather than recognising, vocabulary above all. The prompt admits one answer, such as a translation or a sentence with ___ where the word goes; accepted lists every answer that is right (other spellings; with and without accents only if both are correct), the most usual first; answerLanguage is the answers' language. If you cannot list every right answer, narrow the prompt until you can.
An objective's tasks are all of one kind: recognising and recalling are different abilities, and Braivo counts every answer on an objective alike.
For vocabulary, each word or phrase is its own objective, one meaning each. Write for the learners described, in their language, about what the material teaches.

Every quote is copied exactly from one continuous passage of the material and must occur only once in it: Braivo checks each one, and drops what it cannot find or finds more than once. Line breaks may be written as spaces; the words, their order, letter case, and punctuation stay as in the material. Material repeats itself: a word in a word list comes back in the examples, the dialogue, and the exercises, and so do whole example sentences. So before choosing a quote, look for its words elsewhere in the material, and if they are there, extend the quote with the words right next to it until no other place matches, such as the translation beside a word in a word list, a dialogue line's speaker, or an exercise's number. Never join words from separate places, and never paraphrase. For example, where a word list has "le pain" on the line above "the bread", the examples have "Je voudrais le pain, s'il vous plaît." and a dialogue has "Paul: Je voudrais le pain, s'il vous plaît.", quote "le pain the bread" or "Paul: Je voudrais le pain", never "le pain" or "Je voudrais le pain, s'il vous plaît". Teach only what the material teaches.`;

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
    return quotes.slice(0, limit).flatMap((quote) => {
      const location = locateQuote(source.text, quote);
      if (location.kind === "located") return [{ sourceId: source.id, quote }];
      refused.push(`${where}: the quote ${named(quote)} ${QUOTE_REFUSALS[location.kind]}.`);
      return [];
    });
  };

  const objectives: Draft["objectives"] = [];
  for (const [index, objective] of parsed.data.objectives.entries()) {
    const where = objective.title.trim()
      ? `Objective ${named(objective.title)}`
      : "An untitled objective";
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
      const at = `${where}, ${task.prompt.trim() ? `task ${named(task.prompt)}` : "a task without a question"}`;
      if (taskIndex >= MAX_TASKS) {
        refused.push(`${at}: more than ${MAX_TASKS} tasks were drafted.`);
        continue;
      }
      const { quotes, explanation, answerLanguage, ...fields } = task;
      // A blank explanation, or an answer language Braivo cannot read, is
      // left out: neither is a reason to lose the task. The other kind's
      // fields can stay: the parse reads only its kind's.
      const language = answerLanguage && parseLanguageTag(answerLanguage);
      const body = parseTaskBody({
        ...fields,
        ...(language ? { answerLanguage: language } : {}),
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
