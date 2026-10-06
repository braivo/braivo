// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { runMigrations } from "@braivo/db";
import * as testing from "@braivo/db/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, test } from "vite-plus/test";

import { createApi } from "../api/index.ts";
import { createAuth } from "../auth/index.ts";
import { createOutbox, signInWithCode } from "../auth/testing.ts";
import {
  createCourse,
  createObjectives,
  readCourseObjectives,
  recordEvidence,
} from "../persistence/index.ts";
import { createMcpServer } from "./mcp.ts";
import { remoteClient } from "./remote.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const database = testing.sharedDatabase(connectionString ?? "");
const server = "http://localhost:3000";
const outbox = createOutbox();
const auth = createAuth({
  database,
  secret: "mcp-test-secret-that-is-long-enough-32",
  baseURL: server,
  sendMail: outbox.sendMail,
});
const api = createApi({
  auth,
  database,
  baseUrl: server,
});
const fetch = ((input: string | URL, init?: RequestInit) =>
  api.request(input.toString(), init)) as unknown as typeof globalThis.fetch;

const organizationId = "mcp-test-org";
/** One the content owner only learns in, where every other tool would be refused. */
const learningOrganizationId = "mcp-test-learning-org";
/** Made-up learners and a course they study, which the progress tools read. */
const progressOrganizationId = "mcp-test-progress-org";
const otherLearnerId = "mcp-test-other-learner";
const at = new Date("2026-06-01T00:00:00.000Z");

/** An agent, connected to `braivo mcp` as a desktop app would be, signed in as a content owner. */
let agent!: Client;
/** An agent signed in as a learner of the progress organization, who may read only their own report. */
let learnerAgent!: Client;
let progressCourseId!: string;
let learnerId!: string;

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

/** An agent connected to `braivo mcp` with `token`'s session. */
async function connect(token: string): Promise<Client> {
  const mcp = createMcpServer(remoteClient({ server, token }, fetch));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}, as: Client = agent) {
  const result = (await as.callTool({ name, arguments: args })) as ToolResult;
  return { isError: result.isError ?? false, text: result.content[0]!.text };
}

/** A tool's JSON answer, failing the test on an error, which would say why. */
async function json<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { isError, text } = await call(name, args);
  if (isError) throw new Error(text);
  return JSON.parse(text) as T;
}

/** Requires TEST_DATABASE_URL: the point is that the whole path really runs. */
describe.skipIf(!connectionString)("braivo mcp", () => {
  beforeAll(async () => {
    await runMigrations(connectionString ?? "");

    // A device-flow token is a bearer session; one from signing in is the same kind.
    const email = `mcp-test-${crypto.randomUUID()}@example.com`;
    const { token, id } = await signInWithCode(
      (path, init) => api.request(`/api/auth${path}`, init),
      outbox,
      { email, name: email },
    );
    await testing.seedOrganization(database, {
      organizationId,
      learnerIds: [],
      adminIds: [id],
      at,
    });
    await testing.seedOrganization(database, {
      organizationId: learningOrganizationId,
      learnerIds: [id],
      at,
    });

    agent = await connect(token);

    // A learner of an organization the content owner administers, and another
    // the content owner reads about but who has no session here.
    const learner = await signInWithCode(
      (path, init) => api.request(`/api/auth${path}`, init),
      outbox,
      { email: `mcp-test-${crypto.randomUUID()}@example.com`, name: "Ana" },
    );
    learnerId = learner.id;
    await testing.seedOrganization(database, {
      organizationId: progressOrganizationId,
      learnerIds: [learnerId, otherLearnerId],
      adminIds: [id],
      at,
    });
    const [greetings, numbers] = (await createObjectives(database, progressOrganizationId, [
      "Greetings",
      "Numbers",
    ])) as [string, string];
    progressCourseId = await createCourse(database, {
      organizationId: progressOrganizationId,
      title: "Beginners",
      objectiveIds: [greetings, numbers],
    });
    await recordEvidence(database, { learnerId, organizationId: progressOrganizationId }, [
      { id: "mcp-test-evidence-1", objectiveId: greetings, outcome: "success", at },
    ]);
    learnerAgent = await connect(learner.token);
  });

  test("tells the agent the workflow, and that every quote is checked", () => {
    expect(agent.getInstructions()).toContain("Braivo checks every quote against the source.");
    expect(agent.getInstructions()).toContain("course_progress, then learner_progress");
  });

  test("offers the tools a course is built with", async () => {
    const { tools } = await agent.listTools();

    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "add_document",
      "add_source",
      "add_transcript",
      "author_tasks",
      "cite_sources",
      "course_progress",
      "create_course",
      "define_objectives",
      "learner_progress",
      "list_courses",
      "list_objectives",
      "list_organizations",
      "list_sources",
      "list_tasks",
      "read_course",
      "read_source",
      "retire_tasks",
    ]);
  });

  test("gives every tool a title and all four hints, so a client need not assume the worst", async () => {
    const { tools } = await agent.listTools();

    for (const tool of tools) {
      expect(tool.title?.trim(), `${tool.name} has no title`).toBeTruthy();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name} does not declare ${hint}`).toBe(
          "boolean",
        );
      }
    }
  });

  test("reads a course's progress as its administrator, learners named", async () => {
    const overview = await json<{
      learners: { userId: string; name: string; standings: Record<string, number> }[];
      objectives: { title: string; standings: Record<string, number> }[];
    }>("course_progress", { courseId: progressCourseId });

    const standingOf = (userId: string) =>
      overview.learners.find((learner) => learner.userId === userId);
    // Greetings was answered once, long ago, so it is due; Numbers was never seen.
    expect(standingOf(learnerId)).toMatchObject({
      name: "Ana",
      standings: { unseen: 1, acquiring: 0, retained: 0, due: 1 },
    });
    expect(standingOf(otherLearnerId)?.standings).toEqual({
      unseen: 2,
      acquiring: 0,
      retained: 0,
      due: 0,
    });
    expect(overview.objectives.map((objective) => objective.title)).toEqual([
      "Greetings",
      "Numbers",
    ]);
  });

  test("reads one learner's standing on each objective, with the evidence behind it", async () => {
    const report = await json<{
      objectives: { title: string; evidence: { outcome: string; at: string }[] }[];
    }>("learner_progress", { courseId: progressCourseId, learnerId });

    expect(report.objectives.map((objective) => objective.title)).toEqual(["Greetings", "Numbers"]);
    expect(report.objectives[0]!.evidence).toEqual([{ outcome: "success", at: at.toISOString() }]);
    expect(report.objectives[1]!.evidence).toEqual([]);
  });

  test("hands a learner Braivo's refusal, not a crash, when they ask for the course overview", async () => {
    const refused = await call("course_progress", { courseId: progressCourseId }, learnerAgent);

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("404");
  });

  test("lets a learner read their own report", async () => {
    const own = await call(
      "learner_progress",
      { courseId: progressCourseId, learnerId },
      learnerAgent,
    );

    expect(own.isError).toBe(false);
    expect(JSON.parse(own.text).objectives).toHaveLength(2);
  });

  test("refuses a learner another learner's report", async () => {
    const refused = await call(
      "learner_progress",
      { courseId: progressCourseId, learnerId: otherLearnerId },
      learnerAgent,
    );

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("404");
  });

  test("lists only the organizations the content owner manages", async () => {
    const organizations =
      await json<{ id: string; name: string; slug: string }[]>("list_organizations");

    // Not learningOrganizationId: the content owner only studies there.
    expect(organizations.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: organizationId, name: organizationId, slug: organizationId },
      { id: progressOrganizationId, name: progressOrganizationId, slug: progressOrganizationId },
    ]);
  });

  test("adds a book page by page, keeping which page each part is on", async () => {
    const { sourceId } = await json<{ sourceId: string }>("add_document", {
      organizationId,
      title: "Mi primer libro",
      pages: [
        { page: "11", text: "Hola significa hello." },
        { page: "12", text: "Adiós significa goodbye." },
      ],
      language: "es",
    });

    expect(await json("read_source", { organizationId, sourceId })).toMatchObject({
      text: "Hola significa hello.\n\nAdiós significa goodbye.",
      pagination: [
        { start: 0, page: "11" },
        { start: 23, page: "12" },
      ],
    });
  });

  test("says the API's limits in its schemas, so a call past one is refused saying so", async () => {
    const task = {
      objectiveId: "o",
      kind: "choice",
      prompt: "¿Uno?",
      options: ["one", "two"],
      answer: 0,
      citations: Array.from({ length: 10 }, () => ({ sourceId: "s", quote: "Uno." })),
    };

    const refused = await call("author_tasks", {
      organizationId,
      tasks: Array.from({ length: 21 }, () => task),
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Cite at most 200 quotes in one call");

    const { citations: _, ...uncited } = task;
    const correcting = await call("author_tasks", {
      organizationId,
      tasks: [uncited, { ...uncited, answer: 1, replaces: "t" }],
    });
    expect(correcting.isError).toBe(true);
    expect(correcting.text).toContain("Send a task with replaces alone");
  });

  test("refuses a blank title, saying why, before calling Braivo", async () => {
    const refused = await call("define_objectives", {
      organizationId,
      objectives: [{ title: "   " }],
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("must not be blank");
  });

  test("reads no file from this machine, whatever the material it reads asks", async () => {
    const { tools } = await agent.listTools();

    for (const tool of tools)
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("original");
  });

  test("reviews an objective's tasks, corrects a wrong one, and retires another", async () => {
    const { sourceId } = await json<{ sourceId: string }>("add_source", {
      organizationId,
      title: "Los números",
      text: "Uno significa one. Dos significa two.",
    });
    const {
      objectiveIds: [numbers],
    } = await json<{ objectiveIds: string[] }>("define_objectives", {
      organizationId,
      objectives: [{ title: "Numbers", key: `mcp-review-${crypto.randomUUID()}` }],
    });
    const task = (prompt: string, answer: number, quote: string) => ({
      objectiveId: numbers,
      kind: "choice",
      prompt,
      options: ["one", "two"],
      answer,
      citations: [{ sourceId, quote }],
    });
    const {
      taskIds: [wrong, right],
    } = await json<{ taskIds: string[] }>("author_tasks", {
      organizationId,
      tasks: [task("¿Uno?", 1, "Uno significa one."), task("¿Dos?", 1, "Dos significa two.")],
    });

    const listed = await json<{ id: string; answer: number; citations: { quote: string }[] }[]>(
      "list_tasks",
      { organizationId, objectiveId: numbers },
    );
    expect(listed).toMatchObject([
      { id: wrong, prompt: "¿Uno?", answer: 1, citations: [{ quote: "Uno significa one." }] },
      { id: right, prompt: "¿Dos?", answer: 1, citations: [{ quote: "Dos significa two." }] },
    ]);

    // The answer to "¿Uno?" is wrong: correct it, which retires it.
    const {
      taskIds: [fixed],
    } = await json<{ taskIds: string[] }>("author_tasks", {
      organizationId,
      tasks: [{ ...task("¿Uno?", 0, "Uno significa one."), replaces: wrong }],
    });
    const offered = async () =>
      (await json<{ id: string }[]>("list_tasks", { organizationId, objectiveId: numbers })).map(
        ({ id }) => id,
      );
    expect(await offered()).toEqual([right, fixed]);

    expect(await json("retire_tasks", { organizationId, taskIds: [right] })).toEqual({
      retired: 1,
    });
    expect(await offered()).toEqual([fixed]);
  });

  test("builds a grounded course from a transcript, as an agent would", async () => {
    const [organization] = await json<{ id: string }[]>("list_organizations");
    const { sourceId } = await json<{ sourceId: string }>("add_source", {
      organizationId: organization!.id,
      title: "Los colores",
      text: "Rojo significa red.\nAzul significa blue.",
      url: "https://www.youtube.com/watch?v=colores",
      language: "es",
    });
    const read = await json<{ text: string }>("read_source", { organizationId, sourceId });
    expect(read.text).toBe("Rojo significa red.\nAzul significa blue.");

    const { objectiveIds } = await json<{ objectiveIds: string[] }>("define_objectives", {
      organizationId,
      objectives: [
        { title: "Red", key: "red" },
        { title: "Blue", key: "blue" },
      ],
    });
    const [red, blue] = objectiveIds as [string, string];
    await json("cite_sources", {
      organizationId,
      citations: [
        { objectiveId: red, sourceId, quote: "Rojo significa red." },
        { objectiveId: blue, sourceId, quote: "Azul significa blue." },
      ],
    });
    const { taskIds } = await json<{ taskIds: string[] }>("author_tasks", {
      organizationId,
      tasks: [
        {
          objectiveId: red,
          kind: "choice",
          prompt: "¿Qué significa rojo?",
          options: ["red", "blue"],
          answer: 0,
          citations: [{ sourceId, quote: "Rojo significa red." }],
        },
      ],
    });
    const { courseId } = await json<{ courseId: string }>("create_course", {
      organizationId,
      title: "Colores",
      objectiveIds: [red, blue],
    });

    expect(taskIds).toHaveLength(1);
    expect(await readCourseObjectives(database, courseId)).toEqual([red, blue]);
  });

  test("hands Braivo's reason back when it refuses a quote, so the agent can fix it", async () => {
    const { sourceId } = await json<{ sourceId: string }>("add_source", {
      organizationId,
      title: "Repeated",
      text: "sí, sí, sí",
    });
    const [objective] = (
      await json<{ objectiveIds: string[] }>("define_objectives", {
        organizationId,
        objectives: [{ title: "Yes" }],
      })
    ).objectiveIds;

    const refused = await call("cite_sources", {
      organizationId,
      citations: [{ objectiveId: objective, sourceId, quote: "sí" }],
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      "Citation 0: the quote occurs more than once in the source; quote more of it.",
    );
  });

  test("refuses a tool call that is not what the tool takes, before Braivo sees it", async () => {
    const refused = await call("author_tasks", {
      organizationId,
      tasks: [{ objectiveId: "o", kind: "essay", prompt: "Write", options: [], answer: 0 }],
    });

    expect(refused.isError).toBe(true);
  });
});
