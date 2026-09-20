// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  foreignKey,
  index,
  integer,
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
 * rewriting an existing one — rewording is not a material change, which is why
 * `title` is editable while identity is not. The schema cannot enforce that
 * rule; what it can do is refuse to let an objective disappear from under the
 * evidence attributed to it, which is what the restricted references do.
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
  },
  (table) => [
    index("objective_organization_idx").on(table.organizationId),
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
  },
  (table) => [
    index("course_organization_idx").on(table.organizationId),
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
 * the cost has been measured: a decision for a learner with 50,000 of these
 * rows takes about 29ms end to end, one learner at a time against a local
 * database. That settles how it grows with a history's length, not how it
 * behaves under load. While there is no estimate table, replacing the learning
 * model also costs nothing, because nothing needs recomputing.
 * See docs/adr/0007-one-learning-model.md.
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
     * Evidence is about a known learning target, never an arbitrary string: a
     * typo would otherwise record knowledge of something that does not exist,
     * silently and permanently. Restricted rather than cascading, because
     * deleting an objective that has evidence would not tidy that history up,
     * it would destroy its meaning.
     */
    objectiveId: text("objective_id")
      .notNull()
      .references(() => objective.id, { onDelete: "restrict" }),
    outcome: learnerEvidenceOutcome("outcome").notNull(),
    /**
     * When the learner produced the evidence, not when it was written. The
     * model measures elapsed durations against it, so it carries a time zone.
     */
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    /**
     * Keyed per learner, not globally. A retry is always a retry for the same
     * learner, so that is the scope idempotency actually needs — and a global
     * key would add a failure mode instead of a guarantee: one learner's
     * evidence would be dropped as a duplicate whenever another learner's ID
     * collided with it, silently, which is exactly how a grader that builds IDs
     * from task and objective rather than from the attempt would fail.
     */
    primaryKey({ columns: [table.learnerId, table.id] }),
    // Replay reads one learner's whole history in `(at, id)` order; this serves
    // that read as an index scan, and it is the only query shape the table has.
    index("learner_evidence_replay_idx").on(table.learnerId, table.at, table.id),
  ],
);
