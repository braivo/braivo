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
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

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

/** A new attempt on a task this learner answered too recently in another. */
export class RestingTask extends Error {
  constructor() {
    super("The task was answered too recently to answer again.");
    this.name = "RestingTask";
  }
}

/** A located passage a task was written from, positions in code points. */
export type TaskCitation = { sourceId: string; start: number; end: number };

/**
 * Stores tasks with the passages they cite and returns their IDs, positionally
 * matching the tasks given. Bodies must already be valid and citations located
 * — `content` does both — since a stored task is never corrected, only
 * replaced.
 *
 * A task the objective already has, unretired — the same body and the same
 * passages — is not stored again: its ID is returned, so an agent or script
 * retrying after a lost answer duplicates nothing, and the same holds for a
 * task repeated within one batch (docs/adr/0024-idempotent-authoring.md). A
 * retired twin does not count: adding a task again is how to bring it back.
 *
 * One transaction, because a task is immutable: one stored without the
 * citations it was written with could never be given them afterwards. Each
 * objective written to is locked for it, so two writers racing to add the same
 * task store one.
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
  tasks: readonly { objectiveId: string; body: TaskBody; citations?: readonly TaskCitation[] }[],
  createdAt: Date,
): Promise<string[]> {
  if (tasks.length === 0) return [];

  const objectiveIds = [...new Set(tasks.map((item) => item.objectiveId))].toSorted();

  return database.transaction(async (transaction) => {
    await lockObjectiveTasks(transaction, objectiveIds);

    // Every unretired task these objectives have, with its passages: few per
    // objective, and compared here since jsonb equality alone would not
    // compare the citations beside it.
    const stored = await transaction
      .select({ id: task.id, objectiveId: task.objectiveId, body: task.body })
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
    }));

    const rows: (typeof task.$inferInsert)[] = [];
    const citations: (typeof taskCitation.$inferInsert)[] = [];
    const ids = tasks.map((item) => {
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
      if (twin) return twin.id;

      const id = crypto.randomUUID();
      rows.push({
        id,
        organizationId,
        objectiveId: item.objectiveId,
        body,
        createdAt: new Date(createdAt.getTime() + rows.length),
      });
      for (const citation of item.citations ?? []) {
        citations.push({ organizationId, taskId: id, ...citation });
      }
      known.push({ id, objectiveId: item.objectiveId, body, cited });
      return id;
    });

    if (rows.length > 0) await transaction.insert(task).values(rows);
    // The same passage cited twice by one task is one citation, as for objectives.
    if (citations.length > 0) {
      await transaction.insert(taskCitation).values(citations).onConflictDoNothing();
    }
    return ids;
  });
}

/** A task's passages as one comparable value: the same set, however listed or repeated. */
function citedKey(citations: readonly TaskCitation[]): string {
  const keys = citations.map(({ sourceId, start, end }) => JSON.stringify([sourceId, start, end]));
  return JSON.stringify([...new Set(keys)].toSorted());
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
 * Stamps tasks retired; one already retired keeps its first date. Under its
 * objective's lock, as `createTasks` takes it, so a twin that is being added
 * again is either retired before it is found or found and then retired —
 * never returned to the adder as live after it was retired.
 */
export async function markTasksRetired(
  database: Database,
  taskIds: readonly string[],
  at: Date,
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
    await transaction
      .update(task)
      .set({ retiredAt: at })
      .where(and(inArray(task.id, [...taskIds]), isNull(task.retiredAt)));
  });
}

/**
 * Holds, until the transaction ends, the right to change which tasks these
 * objectives have. In one order, so two writers over the same objectives
 * cannot each hold a lock the other waits for.
 */
async function lockObjectiveTasks(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  objectiveIds: readonly string[],
): Promise<void> {
  for (const objectiveId of [...objectiveIds].toSorted()) {
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

/** A task as its author wrote it, with the passages it cites and their words. */
export type AuthoredTask = {
  id: string;
  body: TaskBody;
  citations: (TaskCitation & { quote: string })[];
};

/**
 * An objective's unretired tasks, oldest first as they are offered, each with
 * its cited passages by source and position: what a content owner or their
 * agent reviews before retiring one or writing another.
 */
export async function readObjectiveTasks(
  database: Database,
  objectiveId: string,
): Promise<AuthoredTask[]> {
  const tasks = await database
    .select({ id: task.id, body: task.body })
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

  return tasks.map(({ id, body }) => ({
    id,
    body: body as TaskBody,
    citations: citations
      .filter((citation) => citation.taskId === id)
      .map(({ sourceId, start, end, quote }) => ({ sourceId, start, end, quote })),
  }));
}

/** Which of these objectives have an unretired task, and so something to practise. */
export async function readObjectivesWithTasks(
  database: Database,
  objectiveIds: readonly string[],
): Promise<Set<string>> {
  if (objectiveIds.length === 0) return new Set();

  const rows = await database
    .selectDistinct({ objectiveId: task.objectiveId })
    .from(task)
    .where(and(inArray(task.objectiveId, [...objectiveIds]), isNull(task.retiredAt)));
  return new Set(rows.map((row) => row.objectiveId));
}

/**
 * The objective's unretired task this learner attempted least recently,
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
    .where(and(eq(task.objectiveId, input.objectiveId), isNull(task.retiredAt)))
    .groupBy(task.id)
    .orderBy(sql`${lastAttemptAt} asc nulls first`, asc(task.createdAt), asc(task.id))
    .limit(1);
  return (
    row && { ...row, body: row.body as TaskBody, lastAttemptAt: row.lastAttemptAt ?? undefined }
  );
}

/**
 * A task, provided it assesses one of this course's objectives: answering is
 * authorized through the course, so a task outside it is as good as missing.
 * Retired ones included, so a resend of an attempt recorded before retirement
 * still reaches `recordAttempt`, which refuses only a new one.
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
    .where(eq(task.id, input.taskId));
  return row && { ...row, body: row.body as TaskBody };
}

/**
 * Stores an attempt and the evidence graded from it, together or not at all.
 *
 * Resubmitting the same attempt — same ID, task, and response — stores nothing
 * and returns, so a client may retry after a lost answer; its evidence keeps the
 * first submission's date. The same ID with anything else is `ConflictingAttempt`.
 * IDs are the organization's, as evidence IDs are: the same ID at another
 * organization is another attempt.
 * Compared after the insert, inside the transaction, so two racing submissions
 * see whichever one won (see `recordEvidence`).
 *
 * A new attempt is `RetiredTask` when the task is retired, read `FOR SHARE`:
 * the attempt's foreign key takes only a key-share lock, which does not wait
 * for the update that retires, so an attempt could be recorded after it.
 *
 * A new attempt is `RestingTask` when the learner answered the same task in
 * another attempt after `restWindowStart` (docs/adr/0017-task-rest.md). Checked only
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
    /** Dated by the attempt. */
    evidence: Omit<Evidence, "at">;
  },
): Promise<void> {
  const { learnerId, organizationId, attemptId, taskId, response, at, restWindowStart, evidence } =
    input;

  await database.transaction(async (transaction) => {
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
      if (stored?.taskId === taskId && isDeepStrictEqual(stored.response, response)) return;
      throw new ConflictingAttempt(attemptId);
    }

    const [current] = await transaction
      .select({ retiredAt: task.retiredAt })
      .from(task)
      .where(eq(task.id, taskId))
      .for("share");
    if (current?.retiredAt) throw new RetiredTask();

    const [previous] = await transaction
      .select({ id: attempt.id })
      .from(attempt)
      .where(
        and(
          eq(attempt.learnerId, learnerId),
          eq(attempt.taskId, taskId),
          ne(attempt.id, attemptId),
          gt(attempt.at, restWindowStart),
        ),
      )
      .limit(1);
    // Thrown inside the transaction, so the attempt just inserted goes with it.
    if (previous) throw new RestingTask();

    await transaction
      .insert(learnerEvidence)
      .values({ ...evidence, learnerId, organizationId, at });
  });
}
