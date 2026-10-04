// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth.ts";

/**
 * A stable, assessable learning target, and the unit knowledge estimates are
 * kept for. Content and tasks reference objectives rather than owning them,
 * because the same knowledge recurs: two lessons and a second course may all
 * teach the past tense, and ownership by content would make those three
 * unrelated objectives that Braivo could never recognize as the same knowledge.
 *
 * IDs are opaque and generated, never a content owner's own naming. Two
 * organizations must both be able to teach the past tense, which a shared table
 * of human-chosen keys cannot allow; and `learning` treats an objective ID as an
 * opaque token, so there is nothing for it to read in a meaningful one.
 *
 * A material change to what is being learned creates a new objective rather than
 * rewriting an existing one — rewording is not a material change, so a new
 * `title` keeps the same objective. The schema cannot enforce that rule; what
 * it can do is refuse to let an objective disappear from under the evidence
 * attributed to it, which is what the restricted references do.
 */
export const objective = pgTable(
  "objective",
  {
    id: text("id").primaryKey(),
    /**
     * Restricted rather than cascading, because deleting an organization is not
     * a licence to destroy the history its learners built — evidence hangs from
     * objectives, and cascading from here would take it with them.
     *
     * Better Auth's organization deletion is what eventually needed an answer,
     * and this is it: the delete is refused. `createAuth` states that as a rule
     * before the deletion starts, so it reads as a conflict rather than as the
     * constraint violation this line would otherwise raise; the constraint stays
     * underneath it as the thing that cannot be got around.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    /**
     * The caller's own name for the objective — `es-greetings` — so that adding
     * it again returns it rather than a twin. Optional, and unique within the
     * organization; an objective's content is not its identity, since two with
     * one title can teach different things (docs/adr/0024-idempotent-authoring.md).
     */
    key: text("key"),
  },
  (table) => [
    index("objective_organization_idx").on(table.organizationId),
    uniqueIndex("objective_organization_key_uidx").on(table.organizationId, table.key),
    // Redundant on its own, since `id` is already unique. It exists so that
    // course membership can reference `(organization, objective)` together and
    // have the database refuse an objective belonging to someone else. A
    // constraint rather than a unique index, because Drizzle writes constraints
    // inline in `create table` and indexes after the foreign keys that need them.
    unique("objective_organization_id_key").on(table.organizationId, table.id),
  ],
);

/**
 * An ordered set of objectives a content owner arranges. A course orders
 * objectives; it does not own them, so the same objective may appear in several
 * courses — the past tense taught in two courses is one piece of knowledge and
 * one estimate. See docs/adr/0008-courses-order-objectives.md.
 */
export const course = pgTable(
  "course",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    /** The caller's own name for the course, as on `objective`. */
    key: text("key"),
  },
  (table) => [
    index("course_organization_idx").on(table.organizationId),
    uniqueIndex("course_organization_key_uidx").on(table.organizationId, table.key),
    /** Referenced together with the organization, for the same reason as on `objective`. */
    unique("course_organization_id_key").on(table.organizationId, table.id),
  ],
);

/**
 * Membership, carrying the content order `learning` consumes as list position.
 * The `position` column exists only here: a database needs somewhere to put an
 * order, and a list already is one, so `readCourseObjectives` erases it. That
 * keeps the spec's property — a candidate list cannot express conflicting
 * positions — true of the whole path rather than only of the type, and the
 * primary key below keeps an objective from appearing twice.
 */
export const courseObjective = pgTable(
  "course_objective",
  {
    /**
     * Carried on the row so that both references below can include it. Simple
     * foreign keys would check only that the course and the objective exist,
     * which lets one organization's course arrange another's objectives, and
     * selection would then hand a learner an objective from a course they are
     * looking at but an organization they have nothing to do with. Matching the
     * organization on both sides makes that unrepresentable rather than a rule
     * the one writer has to remember.
     */
    organizationId: text("organization_id").notNull(),
    courseId: text("course_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    // An objective appears in a course at most once, and no two of them claim
    // the same position — the two ways an order could otherwise contradict
    // itself, both refused by the database rather than resolved by a sort.
    primaryKey({ columns: [table.courseId, table.objectiveId] }),
    uniqueIndex("course_objective_position_uidx").on(table.courseId, table.position),
    foreignKey({
      name: "course_objective_course_fk",
      columns: [table.organizationId, table.courseId],
      foreignColumns: [course.organizationId, course.id],
    }).onDelete("cascade"),
    /**
     * Restricted, unlike the course: dropping a course discards an arrangement
     * of objectives, while dropping an objective still in use would remove the
     * thing being arranged.
     */
    foreignKey({
      name: "course_objective_objective_fk",
      columns: [table.organizationId, table.objectiveId],
      foreignColumns: [objective.organizationId, objective.id],
    }).onDelete("restrict"),
  ],
);

/**
 * Binary by design. A continuous score would have to mean the same thing across
 * graders for the learning model to use it, and nothing in v1 establishes that;
 * the grader owns the rubric, the raw score, and the threshold, and emits only
 * the outcome. See docs/specs/learning-model.md.
 */
export const learnerEvidenceOutcome = pgEnum("learner_evidence_outcome", ["success", "failure"]);

/**
 * Normalized learner evidence: the source of truth every knowledge estimate is
 * derived from. Estimates are disposable and reconstructible by replaying these
 * rows, which makes this the table that must not lose anything — and the reason
 * there is deliberately no estimate table beside it.
 *
 * Storing derived estimates would be an optimization for a measured cost, and
 * the measurements do not call for it (docs/adr/0007-one-learning-model.md,
 * docs/adr/0032-learner-history.md). While there is no estimate table,
 * replacing the learning model also costs nothing, because nothing needs
 * recomputing.
 */
export const learnerEvidence = pgTable(
  "learner_evidence",
  {
    /**
     * The grading result's own ID rather than a generated key, so redelivering
     * one result stores no second row, and a different result under the same ID
     * is refused rather than stored. This is what
     * the learning model means by evidence identity making delivery idempotent.
     */
    id: text("id").notNull(),
    /**
     * Cascading, unlike everything else here: deleting an account erases the
     * learning history it built, since that history is the person's data. An
     * organization's deletion is refused instead, because the history is not
     * the organization's to discard.
     */
    learnerId: text("learner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The organization that recorded it, always its objective's: where the
     * record came from. Not membership, which changes while evidence must
     * outlive it (docs/adr/0032-learner-history.md).
     */
    organizationId: text("organization_id").notNull(),
    /**
     * Evidence is about a known learning target, never an arbitrary string: a
     * typo would otherwise record knowledge of something that does not exist,
     * silently and permanently. Referenced with the organization below.
     */
    objectiveId: text("objective_id").notNull(),
    outcome: learnerEvidenceOutcome("outcome").notNull(),
    /**
     * When the learner produced the evidence, not when it was written. The
     * model measures elapsed durations against it, so it carries a time zone.
     */
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    /**
     * Keyed per learner and organization, not globally. A retry is always a
     * retry for the same learner at the same organization, so that is the scope
     * idempotency actually needs — and a wider key would add a failure mode
     * instead of a guarantee. Across learners, one learner's evidence would be
     * dropped as a duplicate whenever another's ID collided with it, silently,
     * which is exactly how a grader that builds IDs from task and objective
     * rather than from the attempt would fail. Across organizations, whose
     * graders name evidence independently, one's ID would refuse the other's
     * write, and the refusal would tell it what the learner did elsewhere.
     */
    primaryKey({ columns: [table.learnerId, table.organizationId, table.id] }),
    /**
     * Matching the organization, as `task` does, so evidence cannot claim an
     * organization other than its objective's. Restricted rather than
     * cascading, because deleting an objective that has evidence would not tidy
     * that history up, it would destroy its meaning.
     */
    foreignKey({
      name: "learner_evidence_objective_fk",
      columns: [table.organizationId, table.objectiveId],
      foreignColumns: [objective.organizationId, objective.id],
    }).onDelete("restrict"),
    // Replay reads one learner's history at one organization in `(at, id)`
    // order; this serves that read as one index range, and a course overview
    // by reading one range per member (docs/adr/0032-learner-history.md).
    index("learner_evidence_replay_idx").on(
      table.learnerId,
      table.organizationId,
      table.at,
      table.id,
    ),
  ],
);

/**
 * One assessable thing a learner does for an objective, such as a question.
 * `body` is one JSON variant per kind, shaped and validated by the server's
 * `content` module. Immutable, which is what lets attempts reference a task
 * rather than copy it. One objective per task for now. See docs/adr/0015-tasks.md.
 */
export const task = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    body: jsonb("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * When a content owner withdrew it — a wrong answer key, say. Never offered
     * after, and accepts no new attempt; kept, since attempts point at it.
     */
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    // Matching the organization, as `course_objective` does, so a task cannot
    // assess another organization's objective.
    foreignKey({
      name: "task_objective_fk",
      columns: [table.organizationId, table.objectiveId],
      foreignColumns: [objective.organizationId, objective.id],
    }).onDelete("restrict"),
    index("task_objective_idx").on(table.objectiveId, table.createdAt, table.id),
    /** Referenced together with the organization, for the same reason as on `objective`. */
    unique("task_organization_id_key").on(table.organizationId, table.id),
  ],
);

/**
 * A learner's answer to a task: what the evidence it produced was graded from.
 * The grade is not stored. Grading `choice` is deterministic over an immutable
 * task, so it is recomputed, and the outcome is in `learner_evidence`.
 */
export const attempt = pgTable(
  "attempt",
  {
    /**
     * Chosen by the client, so a resubmission is recognised rather than recorded
     * twice. Scoped per learner and organization, as evidence IDs are, so
     * neither two learners nor one learner's two organizations collide.
     */
    id: text("id").notNull(),
    /** Cascading: deleting an account erases its learning history, as evidence does. */
    learnerId: text("learner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The task's, as on evidence: where the attempt was made. */
    organizationId: text("organization_id").notNull(),
    taskId: text("task_id").notNull(),
    response: jsonb("response").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.learnerId, table.organizationId, table.id] }),
    foreignKey({
      name: "attempt_task_fk",
      columns: [table.organizationId, table.taskId],
      foreignColumns: [task.organizationId, task.id],
    }).onDelete("restrict"),
    // Serves "which of an objective's tasks this learner saw least recently".
    index("attempt_learner_task_idx").on(table.learnerId, table.taskId, table.at),
  ],
);

/**
 * One request of the installation's model on an organization's behalf —
 * reading a file, drafting a course — counted when asked, whether or not the
 * model answered, since a failed answer may still have been paid for. What an
 * operator's monthly limit is counted against, and a ledger of who spends
 * their credits (docs/adr/0031-ai-limits.md).
 */
export const aiRequest = pgTable(
  "ai_request",
  {
    id: text("id").primaryKey(),
    /** Cascading: the count exists for the organization's limit, which ends with it. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** What was asked: `read` a file, or `draft` a course. */
    kind: text("kind").notNull(),
    /** Who asked, for the ledger; set null if their account goes. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("ai_request_organization_created_idx").on(table.organizationId, table.createdAt),
  ],
);

/**
 * A file a content owner uploaded — a textbook's PDF, a worksheet's scan — as
 * the database knows it: its bytes live in the installation's file store under
 * `organizations/<organizationId>/files/<sha256>` (docs/adr/0028-original-files.md).
 * Named by its SHA-256, so uploading the same bytes again stores them once,
 * and a name is proof of the bytes behind it.
 */
export const file = pgTable(
  "file",
  {
    /** Restricted, as on `source`: a source keeps its original. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** Lowercase hex SHA-256 of the bytes. */
    sha256: text("sha256").notNull(),
    /** The media type it was last uploaded as, such as `application/pdf`; it is served as this. */
    contentType: text("content_type").notNull(),
    /** In bytes. */
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.sha256] })],
);

/**
 * Material a content owner provides, as the text everything derived from it is
 * grounded in: objectives, tasks, and feedback cite it rather than paraphrase
 * it. An original file — a PDF, a recording — is where the text came from, not
 * a substitute for it; whoever extracted the text, Braivo or the content
 * owner's own tools, hands over the same thing.
 *
 * Immutable, like a task: a revised document is a new source. Citations
 * address this text by position, so it must never change beneath them. See
 * docs/adr/0020-source-content.md.
 */
export const source = pgTable(
  "source",
  {
    id: text("id").primaryKey(),
    /** Restricted, as on `objective`: a source is what derived content is answerable to. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    /** Normalized by `content` before it is stored, so a position in it means one thing. */
    text: text("text").notNull(),
    /**
     * Where the text came from when that is a link — a YouTube video, a web
     * article — kept instead of a copy. Several sources may share one: each
     * revision of an article is a snapshot of its own.
     */
    url: text("url"),
    /** The text's main language as a canonical BCP 47 tag, such as `es` or `en-US`. */
    language: text("language"),
    /**
     * For a transcript, where each cue begins in `text` (in code points) and at
     * which second of the recording: `[{ "start": 0, "at": 12.5 }, …]`, ordered
     * by `start`. What lets a passage cited from a video name its moment
     * (docs/adr/0025-timed-transcripts.md). Null for text that is not timed.
     */
    timing: jsonb("timing"),
    /**
     * For a document, where each page begins in `text` (in code points) and
     * its label as printed: `[{ "start": 0, "page": "12" }, …]`, ordered by
     * `start`. What lets a passage cited from a book name its page
     * (docs/adr/0026-paged-documents.md). Null for text without pages; never
     * set with `timing`.
     */
    pagination: jsonb("pagination"),
    /**
     * The uploaded file the text was extracted from, by its SHA-256, when the
     * content owner kept one: what a later extraction, or a person checking
     * this one, starts from. Null for text with no file behind it.
     */
    original: text("original"),
    /**
     * What the source is — its title, text, link, language, timing or
     * pagination, and original — as a SHA-256 hex digest, which
     * `content.sourceDigest` defines. Adding a source already there returns it
     * rather than storing it twice, so an agent or a script that retries after
     * a lost answer duplicates nothing (docs/adr/0024-idempotent-authoring.md).
     */
    digest: text("digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("source_organization_idx").on(table.organizationId),
    /** Referenced together with the organization, for the same reason as on `objective`. */
    unique("source_organization_id_key").on(table.organizationId, table.id),
    // One row per source per organization, whoever races to add it.
    uniqueIndex("source_organization_digest_uidx").on(table.organizationId, table.digest),
    foreignKey({
      name: "source_original_fk",
      columns: [table.organizationId, table.original],
      foreignColumns: [file.organizationId, file.sha256],
    }).onDelete("restrict"),
  ],
);

/**
 * A passage of a source that teaches an objective: the link that keeps derived
 * content answerable to its source. Many to many, because knowledge recurs —
 * the past tense taught in two textbooks is one objective citing both.
 *
 * Stored as a range rather than as the quote the caller sent, since the source
 * is immutable and the range is what was verified: `content` located the quote
 * in the text before this row was written. Positions count Unicode code points,
 * which is what PostgreSQL's `substr` counts, so the passage can be read back
 * without loading the whole text. See docs/adr/0021-citations.md.
 */
export const objectiveCitation = pgTable(
  "objective_citation",
  {
    /** Carried so both references match it, as on `course_objective`. */
    organizationId: text("organization_id").notNull(),
    objectiveId: text("objective_id").notNull(),
    sourceId: text("source_id").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
  },
  (table) => [
    // The same passage cited twice for one objective is one citation, so a
    // retried write stores nothing new.
    primaryKey({ columns: [table.objectiveId, table.sourceId, table.start, table.end] }),
    // Serves "what does this source teach", for reviewing a source's coverage.
    index("objective_citation_source_idx").on(table.sourceId),
    // Restricted both ways: a citation is the record of why an objective exists,
    // and deleting either end would leave the other unexplained.
    foreignKey({
      name: "objective_citation_objective_fk",
      columns: [table.organizationId, table.objectiveId],
      foreignColumns: [objective.organizationId, objective.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "objective_citation_source_fk",
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [source.organizationId, source.id],
    }).onDelete("restrict"),
  ],
);

/**
 * A passage of a source a task was written from: what its question asks about
 * and its explanation relies on. Shaped and verified like `objective_citation`,
 * but written only with its task, in one transaction: a task is immutable, so
 * what it was grounded in is fixed when it is created. See
 * docs/adr/0021-citations.md.
 */
export const taskCitation = pgTable(
  "task_citation",
  {
    organizationId: text("organization_id").notNull(),
    taskId: text("task_id").notNull(),
    sourceId: text("source_id").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.sourceId, table.start, table.end] }),
    index("task_citation_source_idx").on(table.sourceId),
    foreignKey({
      name: "task_citation_task_fk",
      columns: [table.organizationId, table.taskId],
      foreignColumns: [task.organizationId, task.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_citation_source_fk",
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [source.organizationId, source.id],
    }).onDelete("restrict"),
  ],
);
