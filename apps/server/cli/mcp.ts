// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

import { isStorableText, MAX_TITLE } from "../content/index.ts";

// `braivo mcp`: Braivo as tools a desktop agent — Claude, Codex, Grok — calls
// while it prepares a content owner's material on their own machine, at their
// own AI cost (docs/adr/0023-mcp-server.md). Each tool is one call of Braivo's
// client, as the signed-in content owner; nothing here decides anything the
// API does not, so the agent is held to the same rules as the console.

/**
 * Read once by the agent when it connects: the workflow, and the one rule it
 * cannot see from any single tool — that every quote is checked.
 */
const INSTRUCTIONS = `Braivo turns a content owner's material into an adaptive course.
Work as the signed-in content owner, in an organization from list_organizations.

1. add_source: the material as plain text. For a book, worksheet, or slides use
   add_document page by page, so passages name the page to turn to; for a video
   or other recording, add_transcript with its captions, so passages take a
   learner to the moment they are said. Keep its link (url) and language. Or
   pick one from list_sources and read it with read_source.
2. define_objectives: what the material teaches, one assessable target each.
   Reuse an existing objective from list_objectives rather than duplicating it.
3. cite_sources: for each objective, the exact words of the source that teach it.
4. author_tasks: questions that practise each objective, each citing the words
   it was written from.
5. create_course: the objectives in the order learners should meet them.

To review or improve a course, read_course shows it whole, and list_tasks one
objective's tasks, with their answers and quotes. Tasks are never edited:
author_tasks with replaces, one task a call, writes a wrong one's correction
and retires it in one step, and retire_tasks withdraws one.

Braivo checks every quote against the source. Copy quotes verbatim; line breaks
and spacing may differ, nothing else. A quote must occur exactly once: if Braivo
says it occurs more than once, quote more of the passage. A refused batch stores
nothing, so fix what the error names and send the whole batch again.

Every call is safe to repeat. A source or task already there is returned, not
added twice. Give each objective and course a key — es-greetings — and send the
same key again when you repeat a call; a key already naming something else is
refused, so pick another.`;

const organizationId = z
  .string()
  .min(1)
  .describe("The organization's ID, from list_organizations.");

/**
 * Optional to the API, and asked for here: an agent retries, and a key is what
 * makes a retried objective or course the same one rather than a twin.
 */
const key = z
  .string()
  .optional()
  .describe(
    "Your own name for it, unique in the organization, such as es-greetings: lowercase letters, digits, and . _ / -. Reuse it on a retry.",
  );

const quote = z
  .string()
  .min(1)
  .max(2000)
  .describe("The source's exact words, copied verbatim; must occur exactly once in it.");

// The API's own limits, said in the schemas so an agent learns of one from the
// tool's description, before it calls.

/** Text a person reads, as the API stores it: not blank, no NUL, at most `max`. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => isStorableText(value, max), {
      message: "must not be blank, nor hold a NUL or an unpaired surrogate",
    });

/** A source's, an objective's, or a course's title. */
const title = text(MAX_TITLE);

/** A task's question, option, or explanation: `content`'s limit on each. */
const taskText = text(2000);

/** How many quotes one call may ask Braivo to find, each a scan of its source. */
const MAX_QUOTES = 200;

export { StdioServerTransport };

/** Braivo's tools, reaching it through `client` as the signed-in content owner. */
export function createMcpServer(client: BraivoClient): McpServer {
  const server = new McpServer(
    { name: "braivo", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_organizations",
    {
      description:
        "The organizations the signed-in content owner manages: where the other tools work.",
      annotations: { readOnlyHint: true },
    },
    () => answer(client.listOrganizations()),
  );

  server.registerTool(
    "list_sources",
    {
      description: "An organization's sources, by title, without their text.",
      inputSchema: { organizationId },
      annotations: { readOnlyHint: true },
    },
    ({ organizationId }) => answer(client.listSources(organizationId)),
  );

  server.registerTool(
    "read_source",
    {
      description: "One source with its full text: what quotes are cited from.",
      inputSchema: { organizationId, sourceId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    (input) => answer(client.getSource(input)),
  );

  server.registerTool(
    "add_source",
    {
      description:
        "Adds material as plain text and returns its ID. A source is never edited: a revised document is a new source. Adding one already there returns its ID, so retrying is safe.",
      inputSchema: {
        organizationId,
        title,
        text: z
          .string()
          .min(1)
          .describe("Plain text or Markdown: no caption timestamps or markup."),
        url: z.string().optional().describe("Where the text came from, such as a YouTube link."),
        language: z
          .string()
          .optional()
          .describe("The text's main language, as a BCP 47 tag: es, en-US."),
      },
    },
    async (input) => answer({ sourceId: await client.addSource(input) }),
  );

  server.registerTool(
    "add_transcript",
    {
      description:
        "Adds a recording's transcript — a video's captions — as a source, and returns its ID. Braivo joins the cues into the text, one per line, and keeps when each is said, so a passage cited from it takes a learner to that moment of the video. Adding one already there returns its ID.",
      inputSchema: {
        organizationId,
        title,
        cues: z
          .array(
            z.object({
              at: z.number().min(0).describe("When it is said, in seconds from the start."),
              text: z
                .string()
                .min(1)
                .describe("What is said: plain words, no timestamps or markup."),
            }),
          )
          .min(1)
          .describe(
            "The captions in order. Auto-generated captions roll, repeating each line in the next cue: say such a line once. A line the speaker really says twice is two cues.",
          ),
        url: z.string().optional().describe("The recording's link, such as a YouTube URL."),
        language: z
          .string()
          .optional()
          .describe("The language spoken, as a BCP 47 tag: es, en-US."),
      },
    },
    async (input) => answer({ sourceId: await client.addSource(input) }),
  );

  server.registerTool(
    "add_document",
    {
      description:
        "Adds a document — a textbook, a worksheet, slides — page by page as a source, and returns its ID. Braivo joins the pages into the text and keeps where each begins, so a passage cited from it tells a learner which page of their book to turn to. Adding one already there returns its ID.",
      inputSchema: {
        organizationId,
        title,
        pages: z
          .array(
            z.object({
              page: z
                .string()
                .min(1)
                .describe(
                  "The page's number as printed on it — 12, iv — which the reader looks for; the PDF's own count when none is printed.",
                ),
              text: z
                .string()
                .min(1)
                .describe(
                  "The page's text as it reads: no running headers, footers, or page numbers.",
                ),
            }),
          )
          .min(1)
          .describe("The pages in reading order; leave out pages without words."),
        url: z.string().optional().describe("Where the document is online, if it is."),
        language: z
          .string()
          .optional()
          .describe("The text's main language, as a BCP 47 tag: es, en-US."),
      },
    },
    async (input) => answer({ sourceId: await client.addSource(input) }),
  );

  server.registerTool(
    "list_objectives",
    {
      description:
        "An organization's objectives, by title. Reuse one rather than defining it again.",
      inputSchema: { organizationId },
      annotations: { readOnlyHint: true },
    },
    ({ organizationId }) => answer(client.listObjectives(organizationId)),
  );

  server.registerTool(
    "define_objectives",
    {
      description:
        "Defines learning targets — stable, assessable, one each — and returns their IDs in the order given. Give each a key; defining it again under that key returns it.",
      inputSchema: {
        organizationId,
        objectives: z.array(z.object({ title, key })).min(1).max(1000),
      },
    },
    async (input) => answer({ objectiveIds: await client.defineObjectives(input) }),
  );

  server.registerTool(
    "cite_sources",
    {
      description:
        "Links objectives to the passages of sources that teach them. Braivo locates each quote and refuses the whole batch over one it cannot find once.",
      inputSchema: {
        organizationId,
        citations: z
          .array(z.object({ objectiveId: z.string().min(1), sourceId: z.string().min(1), quote }))
          .min(1)
          .max(MAX_QUOTES)
          .describe(`At most ${MAX_QUOTES}; send more in several calls.`),
      },
      annotations: { idempotentHint: true },
    },
    async (input) => answer({ citations: await client.citeSources(input) }),
  );

  server.registerTool(
    "author_tasks",
    {
      description:
        "Adds multiple-choice tasks, each practising one objective and citing the passages it was written from. Returns their IDs; a task already there returns its ID, so retrying is safe. Tasks are never edited: one task sent alone with replaces corrects an existing one.",
      inputSchema: {
        organizationId,
        tasks: z
          .array(
            z.object({
              objectiveId: z.string().min(1),
              kind: z.literal("choice"),
              prompt: taskText,
              options: z.array(taskText).min(2).max(26),
              answer: z
                .number()
                .int()
                .min(0)
                .describe("Index into options of the one correct option."),
              explanation: taskText
                .optional()
                .describe("Shown after grading: why the answer is right."),
              keepOrder: z
                .literal(true)
                .optional()
                .describe("Only when the options' order means something."),
              citations: z
                .array(z.object({ sourceId: z.string().min(1), quote }))
                .max(10)
                .optional(),
              replaces: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "The ID of the task this corrects, of the same objective, retired in the same step. Send it alone; repeating it is safe. If that task is already retired, this succeeds only when exactly this task is offered; otherwise list the tasks again.",
                ),
            }),
          )
          .min(1)
          .max(1000)
          .refine(
            (tasks) =>
              tasks.reduce((sum, task) => sum + (task.citations?.length ?? 0), 0) <= MAX_QUOTES,
            `Cite at most ${MAX_QUOTES} quotes in one call; send the tasks in several.`,
          )
          .refine(
            (tasks) => tasks.length === 1 || tasks.every((task) => task.replaces === undefined),
            "Send a task with replaces alone: one correction per call.",
          )
          .describe(`Citing at most ${MAX_QUOTES} quotes in all; send more in several calls.`),
      },
    },
    async (input) => answer({ taskIds: await client.defineTasks(input) }),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "An objective's tasks learners are offered, oldest first, each with its ID, answer, and the passages it cites. Read them before writing more, to review a course or to avoid near-duplicates.",
      inputSchema: { organizationId, objectiveId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    (input) => answer(client.listTasks(input)),
  );

  server.registerTool(
    "retire_tasks",
    {
      description:
        "Withdraws tasks from practice: learners are never asked them again, and what they answered stays. To correct a task instead, use author_tasks with replaces. Ask the content owner before retiring tasks you did not just write.",
      inputSchema: {
        organizationId,
        taskIds: z.array(z.string().min(1)).min(1).max(1000),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      await client.retireTasks(input);
      return answer({ retired: input.taskIds.length });
    },
  );

  server.registerTool(
    "list_courses",
    {
      description: "An organization's courses, by title.",
      inputSchema: { organizationId },
      annotations: { readOnlyHint: true },
    },
    ({ organizationId }) => answer(client.listCourses(organizationId)),
  );

  server.registerTool(
    "read_course",
    {
      description:
        "One course as authored: its objectives in the order learners meet them, each with the passages that teach it and its tasks, answers and quotes included. Read it to review a whole course at once.",
      inputSchema: { organizationId, courseId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    (input) => answer(client.readCourse(input)),
  );

  server.registerTool(
    "create_course",
    {
      description:
        "Creates a course over existing objectives, in the order learners meet them. Learners are then taught and reviewed adaptively. Give it a key; creating it again under that key returns it.",
      inputSchema: {
        organizationId,
        title,
        objectiveIds: z.array(z.string().min(1)).max(1000),
        key,
      },
    },
    async (input) => answer({ courseId: await client.defineCourse(input) }),
  );

  return server;
}

/**
 * A tool's answer: the result as JSON text, or, when Braivo refused, its
 * reason as an error the agent reads and can act on — "Citation 2: the quote
 * occurs more than once in the source; quote more of it" — rather than a
 * protocol failure it cannot.
 */
async function answer(result: unknown) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await result, null, 2) }] };
  } catch (error) {
    if (!(error instanceof BraivoError)) throw error;
    return { isError: true, content: [{ type: "text" as const, text: error.message }] };
  }
}
