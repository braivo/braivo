// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { isDeepStrictEqual } from "node:util";

import type { Database } from "@braivo/db";
import {
  attempt,
  courseObjective,
  learnerEvidence,
  source,
  task,
  taskCitation,
} from "@braivo/db/schema";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import {
  momentOf,
  pageOf,
  type Pagination,
  type TaskBody,
  type TaskResponse,
  type Timing,
} from "../content/index.ts";
import type { Evidence } from "../learning/index.ts";

type Task = { id: string; objectiveId: string; body: TaskBody };

/**
 * An attempt ID this learner already used at the organization for a different
 * task or response.
 * Like `ConflictingEvidence`, a client bug to surface rather than a retry to
 * absorb: the first submission's evidence already stands.
 */
export class ConflictingAttempt extends Error {
  constructor(readonly id: string) {
    super(`Attempt "${id}" is already recorded with a different task or response.`);
    this.name = "ConflictingAttempt";
  }
}

/** A new attempt on a retired task. */
export class RetiredTask extends Error {
  constructor() {
    super("The task was retired.");
    this.name = "RetiredTask";
  }
}

/**
 * A correction of a task someone already corrected or retired, written from
 * a stale read, unless what it asks for is already there.
 */
export class StaleCorrection extends Error {
  constructor() {
    super(
      "Task 0 replaces a task already retired; list the objective's tasks again before deciding what to add or correct.",
    );
    this.name = "StaleCorrection";
  }
}

/**
 * A tool's retirement of a task once published, retired since or not: what
 * learners are offered stops only in the console
 * (docs/adr/0039-published-in-the-console.md).
 */
export class PublishedTask extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedTask";
  }
}

/**
 * A correction equal to another task its objective has: answered by that task,
 * it would take that task's state, not the corrected one's (ADR 0039).
 */
export class DuplicateCorrection extends Error {
  constructor() {
    super(
      "Task 0 is the same as another task its objective already has; list the objective's tasks, published and waiting, before deciding what to retire or publish.",
    );
    this.name = "DuplicateCorrection";
  }
}

/**
 * A tool's second correction of a published task while its first still waits:
 * one waits at a time, and it is that one to correct (ADR 0039).
 */
export class CorrectionWaiting extends Error {
  constructor(readonly waitingId: string) {
    super(
      `Task 0 corrects a published task whose correction "${waitingId}" already waits for review; to change it, correct that one instead (replaces "${waitingId}").`,
    );
    this.name = "CorrectionWaiting";
  }
}

/** A new attempt on a task this learner answered too recently in another. */
export class RestingTask extends Error {
  constructor() {
    super("The task was answered too recently to answer again.");
    this.name = "RestingTask";
  }
}

/** A located passage a task was written from, positions in code points. */
export type TaskCitation = { sourceId: string; start: number; end: number };

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What learners are offered: published, and not retired (ADR 0039). */
const offeredTask = and(isNotNull(task.publishedAt), isNull(task.retiredAt));

type NewTask = { objectiveId: string; body: TaskBody; citations?: readonly TaskCitation[] };

/**
 * What a write did with one task, and what learners reach of it (ADR 0039):
 * `added`, false for an unretired twin found instead; `published`, false while
 * it waits for Publish; `replaces`, only while it is a waiting correction, the
 * published task it will retire, offered meanwhile.
 */
export type TaskWriteResult = { id: string; added: boolean; published: boolean; replaces?: string };

/**
 * Stores tasks with the passages they cite and returns what it did with each
 * (`TaskWriteResult`), positionally matching the tasks given. Bodies must
 * already be valid and citations located — `content` does both — since a
 * stored task is never corrected, only replaced (`replaceTask`).
 *
 * A task the objective already has, unretired — the same body and the same
 * passages — is not stored again but answered, `added` false, so an agent or
 * script retrying after a lost answer duplicates nothing, and the same holds
 * for a task repeated within one batch (ADR 0024). A retired twin does not
 * count: adding a task again is how to bring it back.
 *
 * One transaction, because a task is immutable: one stored without the
 * citations it was written with could never be given them afterwards. Each
 * objective written to is locked for it, so two writers racing to add the same
 * task store one.
 *
 * A new task is `published` at once or waits for Publish; a twin keeps its
 * state either way, since a write never publishes what it did not add.
 *
 * Each new task is stamped a millisecond after the one before it, so tasks
 * created together are offered in the order given, not by random ID
 * (`readNextTask` breaks ties oldest first). A batch sent sooner after a large
 * one than its size in milliseconds may interleave with it; an ordering column
 * would fix that if authoring needs one.
 */
export async function createTasks(
  database: Database,
  organizationId: string,
  tasks: readonly NewTask[],
  createdAt: Date,
  { published }: { published: boolean },
): Promise<TaskWriteResult[]> {
  if (tasks.length === 0) return [];

  return database.transaction(async (transaction) => {
    await lockObjectiveTasks(
      transaction,
      tasks.map((item) => item.objectiveId),
    );
    return storeTasks(transaction, organizationId, tasks, createdAt, { published });
  });
}

/**
 * Stores a task's correction, as `createTasks` stores a task. The task,
 * `replaces`, must be the organization's and assess the correction's
 * objective; one that does not exist is taken as retired.
 *
 * A tool's correction of a published task waits, the task still offered, until
 * Publish publishes the one and retires the other (`publishTasks`); the task
 * has one waiting correction at most, and a second is refused
 * (`CorrectionWaiting`). Otherwise the task is retired in the same transaction,
 * so learners meet one or the other, never both or neither; the correction
 * takes its state, published or waiting, so editing during review publishes
 * nothing (ADR 0039), and a waiting correction's replacement corrects the same
 * published task. Correcting a published task in the console retires its
 * waiting correction too.
 *
 * A correction equal to the task answers the task, changing nothing; one equal
 * to another task is refused (`DuplicateCorrection`), unless it is the task's
 * waiting correction, sent again. Once the task is retired, a correction
 * answers what it asks for if that is already there (a retry, or someone's
 * same correction), changing nothing; otherwise it was written from a stale
 * read and is refused (`StaleCorrection`), never stored beside whatever
 * replaced the task.
 */
export async function replaceTask(
  database: Database,
  organizationId: string,
  replaces: string,
  correction: NewTask,
  createdAt: Date,
  { byTool }: { byTool: boolean },
): Promise<TaskWriteResult> {
  return database.transaction(async (transaction) => {
    await lockObjectiveTasks(transaction, [correction.objectiveId]);
    // Links change only under that lock, so they can be read before the rows are locked.
    const [link] = await transaction
      .select({ replacesTaskId: task.replacesTaskId })
      .from(task)
      .where(eq(task.id, replaces));
    const corrections = await readWaitingCorrections(transaction, [replaces]);
    // The corrected task's own, when it is a waiting correction: a new row's
    // key references it, which would otherwise wait on Publish out of order.
    const rows = await lockTasks(transaction, [replaces, link?.replacesTaskId, ...corrections]);
    const replaced = rows.find((row) => row.id === replaces);
    const live = replaced?.retiredAt === null;
    const published = live && replaced.publishedAt !== null;
    // One Publish published meanwhile retired the task, which `live` says.
    const waiting = rows.find((row) => corrections.includes(row.id) && isWaiting(row))?.id;

    if (byTool && published) {
      const [written] = await storeTasks(transaction, organizationId, [correction], createdAt, {
        published: false,
        replacesTaskId: replaces,
      });
      if (written!.id === replaces || written!.id === waiting) return written!;
      // Thrown inside the transaction, so a correction just stored goes with it.
      if (!written!.added) throw new DuplicateCorrection();
      if (waiting) throw new CorrectionWaiting(waiting);
      return written!;
    }

    const [written] = await storeTasks(transaction, organizationId, [correction], createdAt, {
      published,
      // A waiting correction's replacement corrects the same published task.
      replacesTaskId: (live && !published && replaced.replacesTaskId) || undefined,
    });
    if (written!.id === replaces) return written!;
    if (!live) {
      if (written!.added) throw new StaleCorrection();
      return written!;
    }
    if (!written!.added) throw new DuplicateCorrection();
    await transaction
      .update(task)
      .set({ retiredAt: createdAt })
      .where(inArray(task.id, waiting ? [replaces, waiting] : [replaces]));
    return written!;
  });
}

/** `createTasks`' writes, under its locks, and what each did. */
async function storeTasks(
  transaction: Transaction,
  organizationId: string,
  tasks: readonly NewTask[],
  createdAt: Date,
  { published, replacesTaskId }: { published: boolean; replacesTaskId?: string },
): Promise<TaskWriteResult[]> {
  const objectiveIds = [...new Set(tasks.map((item) => item.objectiveId))];

  // Every unretired task these objectives have, published or waiting, with
  // its passages: few per objective, and compared here since jsonb equality alone would not
  // compare the citations beside it.
  const stored = await transaction
    .select({
      id: task.id,
      objectiveId: task.objectiveId,
      body: task.body,
      publishedAt: task.publishedAt,
      replacesTaskId: task.replacesTaskId,
    })
    .from(task)
    .where(
      and(
        eq(task.organizationId, organizationId),
        inArray(task.objectiveId, objectiveIds),
        isNull(task.retiredAt),
      ),
    );
  const passages = stored.length
    ? await transaction
        .select({
          taskId: taskCitation.taskId,
          sourceId: taskCitation.sourceId,
          start: taskCitation.start,
          end: taskCitation.end,
        })
        .from(taskCitation)
        .where(
          inArray(
            taskCitation.taskId,
            stored.map((row) => row.id),
          ),
        )
    : [];
  const known = stored.map((row) => ({
    id: row.id,
    objectiveId: row.objectiveId,
    body: row.body,
    cited: citedKey(passages.filter((passage) => passage.taskId === row.id)),
    published: row.publishedAt !== null,
    replacesTaskId: row.replacesTaskId ?? undefined,
  }));

  const rows: (typeof task.$inferInsert)[] = [];
  const citations: (typeof taskCitation.$inferInsert)[] = [];
  const written = tasks.map((item): TaskWriteResult => {
    // Compared as it will be stored: `jsonb` keeps what JSON can say, so a
    // value JSON cannot — an answer of -0, stored as 0 — must not make a
    // retry look like another task.
    const body = JSON.parse(JSON.stringify(item.body)) as TaskBody;
    const cited = citedKey(item.citations ?? []);
    const twin = known.find(
      (candidate) =>
        candidate.objectiveId === item.objectiveId &&
        candidate.cited === cited &&
        // Key order does not matter, option order does: it is what `answer` indexes.
        isDeepStrictEqual(candidate.body, body),
    );
    if (twin) return { ...stateOf(twin), id: twin.id, added: false };

    const id = crypto.randomUUID();
    const stamped = new Date(createdAt.getTime() + rows.length);
    rows.push({
      id,
      organizationId,
      objectiveId: item.objectiveId,
      body,
      createdAt: stamped,
      publishedAt: published ? stamped : null,
      replacesTaskId,
    });
    for (const citation of item.citations ?? []) {
      citations.push({ organizationId, taskId: id, ...citation });
    }
    // Found again later in this batch as a twin, not as added.
    known.push({ id, objectiveId: item.objectiveId, body, cited, published, replacesTaskId });
    return { ...stateOf({ published, replacesTaskId }), id, added: true };
  });

  if (rows.length > 0) await transaction.insert(task).values(rows);
  // The same passage cited twice by one task is one citation, as for objectives.
  if (citations.length > 0) {
    await transaction.insert(taskCitation).values(citations).onConflictDoNothing();
  }
  return written;
}

/** What learners reach of a stored task: `TaskWriteResult`'s `published` and `replaces`. */
function stateOf(row: { published: boolean; replacesTaskId: string | undefined }) {
  return {
    published: row.published,
    // The column outlives Publish as a record; the answer names it only while waiting.
    ...(!row.published && row.replacesTaskId !== undefined && { replaces: row.replacesTaskId }),
  };
}

/** A task's passages as one comparable value: the same set, however listed or repeated. */
function citedKey(citations: readonly TaskCitation[]): string {
  const keys = citations.map(({ sourceId, start, end }) => JSON.stringify([sourceId, start, end]));
  return JSON.stringify([...new Set(keys)].toSorted());
}

/** The objective an organization's task assesses, or `undefined` for a task not its own. */
export async function readTaskObjective(
  database: Database,
  organizationId: string,
  taskId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ objectiveId: task.objectiveId })
    .from(task)
    .where(and(eq(task.organizationId, organizationId), eq(task.id, taskId)));
  return row?.objectiveId;
}

/** The IDs among these that are not the organization's tasks, missing ones included. */
export async function findTasksOutsideOrganization(
  database: Database,
  organizationId: string,
  taskIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(taskIds)];
  if (wanted.length === 0) return [];

  const owned = await database
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.organizationId, organizationId), inArray(task.id, wanted)));

  const inside = new Set(owned.map((row) => row.id));
  return wanted.filter((id) => !inside.has(id));
}

/**
 * Stamps tasks retired, with the corrections waiting for them; one already
 * retired keeps its first date. Under its objective's lock, as `createTasks`
 * takes it, so a twin that is being added again is either retired before it
 * is found or found and then retired — never returned to the adder as live
 * after it was retired. A tool retires only tasks never published: one
 * published among them, retired since or not, refuses all (`PublishedTask`).
 */
export async function markTasksRetired(
  database: Database,
  taskIds: readonly string[],
  at: Date,
  { byTool }: { byTool: boolean },
): Promise<void> {
  if (taskIds.length === 0) return;

  await database.transaction(async (transaction) => {
    const objectives = await transaction
      .selectDistinct({ objectiveId: task.objectiveId })
      .from(task)
      .where(inArray(task.id, [...taskIds]));
    await lockObjectiveTasks(
      transaction,
      objectives.map((row) => row.objectiveId),
    );
    const corrections = await readWaitingCorrections(transaction, taskIds);
    const rows = await lockTasks(transaction, [...taskIds, ...corrections]);
    const published = rows.find((row) => taskIds.includes(row.id) && row.publishedAt !== null);
    if (byTool && published) {
      throw new PublishedTask(
        published.retiredAt === null
          ? `Task "${published.id}" is published, which a tool cannot change; its owner retires it in Braivo's console.`
          : `Task "${published.id}" was published and is retired already; leave it out.`,
      );
    }
    // One Publish published meanwhile waits no longer, and stays.
    const retired = [
      ...taskIds,
      ...corrections.filter((id) => rows.some((row) => row.id === id && isWaiting(row))),
    ];
    await transaction
      .update(task)
      .set({ retiredAt: at })
      .where(and(inArray(task.id, retired), isNull(task.retiredAt)));
  });
}

/**
 * Publishes the organization's tasks `taskIds` within `transaction`, all or
 * none, retiring the tasks the corrections among them replace: `false`, and
 * nothing written, when one is not the organization's or is retired, as a
 * corrected task is, or is a correction whose task is. One published already
 * keeps when it was, so a retry changes nothing.
 */
export async function publishTasks(
  transaction: Transaction,
  input: { organizationId: string; taskIds: readonly string[]; now: Date },
): Promise<boolean> {
  const { organizationId, taskIds, now } = input;
  if (taskIds.length === 0) return true;

  const wanted = [...new Set(taskIds)];
  const links = await transaction
    .select({ objectiveId: task.objectiveId, replacesTaskId: task.replacesTaskId })
    .from(task)
    .where(and(inArray(task.id, wanted), isNull(task.publishedAt), isNotNull(task.replacesTaskId)));
  // It retires tasks, so it takes their objectives' locks as writers do, before
  // the rows: a twin an import is answered with is never retired under it.
  await lockObjectiveTasks(
    transaction,
    links.map((row) => row.objectiveId),
  );
  const rows = new Map(
    (await lockTasks(transaction, [...wanted, ...links.map((row) => row.replacesTaskId)])).map(
      (row) => [row.id, row],
    ),
  );
  const replaced: string[] = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (row?.organizationId !== organizationId || row.retiredAt !== null) return false;
    if (row.publishedAt !== null || row.replacesTaskId === null) continue;
    if (rows.get(row.replacesTaskId)?.retiredAt !== null) return false;
    replaced.push(row.replacesTaskId);
  }
  await transaction
    .update(task)
    .set({ publishedAt: now })
    .where(and(inArray(task.id, wanted), isNull(task.publishedAt)));
  if (replaced.length > 0) {
    await transaction.update(task).set({ retiredAt: now }).where(inArray(task.id, replaced));
  }
  return true;
}

/**
 * Locks these tasks' rows and reads them, in ID order and one statement, as
 * every task writer takes its rows, so no two wait on each other. A row a new
 * row's key references counts: the key waits on it.
 */
async function lockTasks(
  transaction: Transaction,
  taskIds: readonly (string | null | undefined)[],
) {
  const wanted = [...new Set(taskIds.filter((id) => id != null))];
  if (wanted.length === 0) return [];
  return transaction
    .select({
      id: task.id,
      organizationId: task.organizationId,
      publishedAt: task.publishedAt,
      retiredAt: task.retiredAt,
      replacesTaskId: task.replacesTaskId,
    })
    .from(task)
    .where(inArray(task.id, wanted))
    .orderBy(task.id)
    .for("update");
}

/** The corrections waiting to replace these tasks, one each at most. */
async function readWaitingCorrections(
  transaction: Transaction,
  taskIds: readonly string[],
): Promise<string[]> {
  const rows = await transaction
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        inArray(task.replacesTaskId, [...taskIds]),
        isNull(task.publishedAt),
        isNull(task.retiredAt),
      ),
    );
  return rows.map((row) => row.id);
}

function isWaiting(row: { publishedAt: Date | null; retiredAt: Date | null }): boolean {
  return row.publishedAt === null && row.retiredAt === null;
}

/**
 * Holds, until the transaction ends, the right to change which tasks these
 * objectives have. In one order, so two writers over the same objectives
 * cannot each hold a lock the other waits for.
 */
async function lockObjectiveTasks(
  transaction: Transaction,
  objectiveIds: readonly string[],
): Promise<void> {
  for (const objectiveId of [...new Set(objectiveIds)].toSorted()) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`braivo:task:${objectiveId}`}, 0))`,
    );
  }
}

/** A passage a task cites, with its quote and what a reader needs to find its source. */
export type CitedTaskPassage = TaskCitation & {
  quote: string;
  /** The second of the recording it is said at, when the source is a timed transcript. */
  at?: number;
  /** The label of the page it is on, when the source is a paged document. */
  page?: string;
  source: { title: string; url?: string };
};

/**
 * The passages a task cites, by source title and then position in the text:
 * the order a learner reads them in.
 */
export async function readTaskCitations(
  database: Database,
  taskId: string,
): Promise<CitedTaskPassage[]> {
  const rows = await database
    .select({
      sourceId: taskCitation.sourceId,
      start: taskCitation.start,
      end: taskCitation.end,
      // Code points on both sides, as for objective citations.
      quote: sql<string>`substr(${source.text}, ${taskCitation.start} + 1, ${taskCitation.end} - ${taskCitation.start})`,
      title: source.title,
      url: source.url,
      timing: source.timing,
      pagination: source.pagination,
    })
    .from(taskCitation)
    .innerJoin(source, eq(source.id, taskCitation.sourceId))
    .where(eq(taskCitation.taskId, taskId))
    .orderBy(asc(source.title), asc(taskCitation.sourceId), asc(taskCitation.start));

  return rows.map(({ title, url, timing, pagination, ...citation }) => {
    // Where the passage begins in the original, when the source keeps that.
    const at = timing === null ? undefined : momentOf(timing as Timing, citation.start);
    const page = pagination === null ? undefined : pageOf(pagination as Pagination, citation.start);
    return {
      ...citation,
      ...(at === undefined ? {} : { at }),
      ...(page === undefined ? {} : { page }),
      source: url === null ? { title } : { title, url },
    };
  });
}

/**
 * A task as its author wrote it, with the passages it cites and their words,
 * and whether it is published or still waits.
 */
export type AuthoredTask = {
  id: string;
  body: TaskBody;
  citations: (TaskCitation & { quote: string })[];
  published: boolean;
  /** While it waits, the published task it corrects, which Publish retires. */
  replaces?: string;
};

/**
 * An objective's unretired tasks, published or waiting, oldest first, each
 * with its cited passages by source and position: what a content owner or
 * their agent reviews before publishing, retiring one, or writing another.
 */
export async function readObjectiveTasks(
  database: Database,
  objectiveId: string,
): Promise<AuthoredTask[]> {
  const tasks = await database
    .select({
      id: task.id,
      body: task.body,
      publishedAt: task.publishedAt,
      replacesTaskId: task.replacesTaskId,
    })
    .from(task)
    .where(and(eq(task.objectiveId, objectiveId), isNull(task.retiredAt)))
    .orderBy(asc(task.createdAt), asc(task.id));
  if (tasks.length === 0) return [];

  const citations = await database
    .select({
      taskId: taskCitation.taskId,
      sourceId: taskCitation.sourceId,
      start: taskCitation.start,
      end: taskCitation.end,
      // Code points on both sides, as for objective citations.
      quote: sql<string>`substr(${source.text}, ${taskCitation.start} + 1, ${taskCitation.end} - ${taskCitation.start})`,
    })
    .from(taskCitation)
    .innerJoin(source, eq(source.id, taskCitation.sourceId))
    .where(
      inArray(
        taskCitation.taskId,
        tasks.map(({ id }) => id),
      ),
    )
    .orderBy(asc(taskCitation.sourceId), asc(taskCitation.start));

  return tasks.map(({ id, body, publishedAt, replacesTaskId }) => ({
    id,
    body: body as TaskBody,
    citations: citations
      .filter((citation) => citation.taskId === id)
      .map(({ sourceId, start, end, quote }) => ({ sourceId, start, end, quote })),
    published: publishedAt !== null,
    ...(publishedAt === null && replacesTaskId !== null && { replaces: replacesTaskId }),
  }));
}

/**
 * Which of these objectives have a task to offer, published and unretired, and
 * so something to practise.
 */
export async function readObjectivesWithTasks(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Set<string>> {
  if (objectiveIds.length === 0) return new Set();

  const rows = await database
    .selectDistinct({ objectiveId: task.objectiveId })
    .from(task)
    .where(and(inArray(task.objectiveId, [...objectiveIds]), offeredTask));
  return new Set(rows.map((row) => row.objectiveId));
}

/**
 * The objective's offered task this learner attempted least recently,
 * never-attempted first, then oldest: rotating through an objective's tasks
 * keeps a learner from answering the one they just saw. `undefined` when the
 * objective has none.
 *
 * `lastAttemptAt` is when this learner last answered it, if ever. It is the
 * least recent, so if it was answered too recently to offer, so was every task
 * of the objective.
 */
export async function readNextTask(
  database: Database,
  input: { learnerId: string; objectiveId: string },
): Promise<(Task & { lastAttemptAt: Date | undefined }) | undefined> {
  const lastAttemptAt = sql<Date | null>`max(${attempt.at})`.mapWith(attempt.at);
  const [row] = await database
    .select({ id: task.id, objectiveId: task.objectiveId, body: task.body, lastAttemptAt })
    .from(task)
    .leftJoin(attempt, and(eq(attempt.taskId, task.id), eq(attempt.learnerId, input.learnerId)))
    .where(and(eq(task.objectiveId, input.objectiveId), offeredTask))
    .groupBy(task.id)
    .orderBy(sql`${lastAttemptAt} asc nulls first`, asc(task.createdAt), asc(task.id))
    .limit(1);
  return (
    row && { ...row, body: row.body as TaskBody, lastAttemptAt: row.lastAttemptAt ?? undefined }
  );
}

/**
 * How many attempts this learner recorded at the organization after `after` on
 * objectives other than `objectiveId`: those that space an objective's rest out
 * (docs/adr/0017-task-rest.md). A resend records nothing and evidence from
 * elsewhere is no attempt, so neither counts. Strictly after: one recorded in
 * the same millisecond is not known to follow, so a tie never ends a rest early.
 */
export async function countOtherAttempts(
  database: Database | Transaction,
  input: { learnerId: string; organizationId: string; objectiveId: string; after: Date },
): Promise<number> {
  const [row] = await database
    .select({ attempts: count() })
    .from(attempt)
    .innerJoin(
      task,
      and(eq(task.organizationId, attempt.organizationId), eq(task.id, attempt.taskId)),
    )
    .where(
      and(
        eq(attempt.learnerId, input.learnerId),
        eq(attempt.organizationId, input.organizationId),
        gt(attempt.at, input.after),
        ne(task.objectiveId, input.objectiveId),
      ),
    );
  return row?.attempts ?? 0;
}

/**
 * A published task, provided it assesses one of this course's objectives:
 * answering is authorized through the course, so a task outside it, or one
 * still waiting, is as good as missing. Retired ones included, so a resend of
 * an attempt recorded before retirement still reaches `recordAttempt`, which
 * refuses only a new one; a task is never unpublished, so a waiting one has no
 * attempt to resend.
 */
export async function readCourseTask(
  database: Database,
  input: { courseId: string; taskId: string },
): Promise<Task | undefined> {
  const [row] = await database
    .select({ id: task.id, objectiveId: task.objectiveId, body: task.body })
    .from(task)
    .innerJoin(
      courseObjective,
      and(
        eq(courseObjective.courseId, input.courseId),
        eq(courseObjective.objectiveId, task.objectiveId),
      ),
    )
    .where(and(eq(task.id, input.taskId), isNotNull(task.publishedAt)));
  return row && { ...row, body: row.body as TaskBody };
}

/**
 * Stores an attempt and the evidence graded from it, together or not at all.
 *
 * Returns the outcome that stands. Resubmitting the same attempt — same ID,
 * task, and response — stores nothing and returns the outcome recorded, even
 * if grading would now say otherwise, so a client may retry after a lost
 * answer; its evidence keeps the first submission's date. The same ID with
 * anything else is `ConflictingAttempt`.
 * IDs are the organization's, as evidence IDs are: the same ID at another
 * organization is another attempt.
 * Compared after the insert, inside the transaction, so two racing submissions
 * see whichever one won (see `recordEvidence`).
 *
 * A new attempt is `RetiredTask` when the task is retired, read `FOR SHARE`:
 * the attempt's foreign key takes only a key-share lock, which does not wait
 * for the update that retires, so an attempt could be recorded after it.
 *
 * A new attempt is `RestingTask` when the learner's latest other attempt on the
 * same task came after `restWindowStart` and fewer than `restAttempts` attempts
 * on other objectives followed it (docs/adr/0017-task-rest.md). Checked only
 * once the insert shows the attempt is new, so a resend is never mistaken for
 * another answer, whatever was answered since.
 */
export async function recordAttempt(
  database: Database,
  input: {
    learnerId: string;
    /** The task's organization, where the attempt and its evidence are recorded. */
    organizationId: string;
    attemptId: string;
    taskId: string;
    response: TaskResponse;
    at: Date;
    restWindowStart: Date;
    restAttempts: number;
    /** Dated by the attempt. */
    evidence: Omit<Evidence, "at">;
  },
): Promise<Evidence["outcome"]> {
  const {
    learnerId,
    organizationId,
    attemptId,
    taskId,
    response,
    at,
    restWindowStart,
    restAttempts,
    evidence,
  } = input;

  return database.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(attempt)
      .values({ id: attemptId, learnerId, organizationId, taskId, response, at })
      .onConflictDoNothing({ target: [attempt.learnerId, attempt.organizationId, attempt.id] })
      .returning({ id: attempt.id });

    if (inserted.length === 0) {
      const [stored] = await transaction
        .select({ taskId: attempt.taskId, response: attempt.response })
        .from(attempt)
        .where(
          and(
            eq(attempt.learnerId, learnerId),
            eq(attempt.organizationId, organizationId),
            eq(attempt.id, attemptId),
          ),
        );
      if (stored?.taskId !== taskId || !isDeepStrictEqual(stored.response, response)) {
        throw new ConflictingAttempt(attemptId);
      }
      const [recorded] = await transaction
        .select({ outcome: learnerEvidence.outcome })
        .from(learnerEvidence)
        .where(
          and(
            eq(learnerEvidence.learnerId, learnerId),
            eq(learnerEvidence.organizationId, organizationId),
            eq(learnerEvidence.id, evidence.id),
          ),
        );
      // Written with the attempt, so never missing: regrading instead would
      // answer an outcome the evidence does not hold.
      if (recorded === undefined) throw new Error(`Attempt ${attemptId} has no evidence.`);
      return recorded.outcome;
    }

    const [current] = await transaction
      .select({ retiredAt: task.retiredAt })
      .from(task)
      .where(eq(task.id, taskId))
      .for("share");
    if (current?.retiredAt) throw new RetiredTask();

    // The latest: an earlier one may have been spaced out while this one was not.
    const [previous] = await transaction
      .select({ at: attempt.at })
      .from(attempt)
      .where(
        and(
          eq(attempt.learnerId, learnerId),
          eq(attempt.taskId, taskId),
          ne(attempt.id, attemptId),
          gt(attempt.at, restWindowStart),
        ),
      )
      .orderBy(desc(attempt.at))
      .limit(1);
    const resting =
      previous !== undefined &&
      (await countOtherAttempts(transaction, {
        learnerId,
        organizationId,
        objectiveId: evidence.objectiveId,
        after: previous.at,
      })) < restAttempts;
    // Thrown inside the transaction, so the attempt just inserted goes with it.
    if (resting) throw new RestingTask();

    await transaction
      .insert(learnerEvidence)
      .values({ ...evidence, learnerId, organizationId, at });
    return evidence.outcome;
  });
}
