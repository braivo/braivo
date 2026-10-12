// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { member, organization } from "./auth.ts";
import { course } from "./learning.ts";

/**
 * Learners and their teachers taking some of an organization's courses
 * together: a school's class, a tutor and one student, a cohort. What scopes
 * teaching: a teacher reads the progress of the group's learners in the
 * group's courses, nothing more (docs/adr/0042-groups-scope-teaching.md).
 */
export const group = pgTable(
  "group",
  {
    id: text("id").primaryKey(),
    /** Cascading: a group records who teaches whom, no history of its own. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The caller's own name for the group, as on `course`. */
    key: text("key"),
    /**
     * The definition the group was created with, hashed: a retry under its key
     * is that request again, whatever has changed in the group since.
     */
    creationDigest: text("creation_digest").notNull(),
  },
  (table) => [
    index("group_organization_idx").on(table.organizationId),
    uniqueIndex("group_organization_key_uidx").on(table.organizationId, table.key),
    /** Referenced together with the organization, for the same reason as on `objective`. */
    unique("group_organization_id_key").on(table.organizationId, table.id),
  ],
);

/** What a person does in a group. Teaching it grants reading its learners' progress. */
export const groupRole = pgEnum("group_role", ["learner", "teacher"]);

/**
 * A member of the organization in one of its groups, in one role there.
 *
 * References the membership itself, by `(organization, user)`, so only a
 * member can be in a group and leaving the organization leaves its groups: a
 * former teacher keeps no access. That pair is unique by the hand-written index
 * in `migrations/*_member_uniqueness`, which must run before this table's.
 */
export const groupMember = pgTable(
  "group_member",
  {
    organizationId: text("organization_id").notNull(),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    role: groupRole("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    foreignKey({
      name: "group_member_group_fk",
      columns: [table.organizationId, table.groupId],
      foreignColumns: [group.organizationId, group.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_member_member_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    // Serves "the groups this person teaches".
    index("group_member_user_idx").on(table.userId, table.role),
  ],
);

/**
 * A course a group takes. What differs between two groups taking one course,
 * a release date or a pace, goes here once a school needs it.
 */
export const groupCourse = pgTable(
  "group_course",
  {
    organizationId: text("organization_id").notNull(),
    groupId: text("group_id").notNull(),
    courseId: text("course_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.courseId] }),
    foreignKey({
      name: "group_course_group_fk",
      columns: [table.organizationId, table.groupId],
      foreignColumns: [group.organizationId, group.id],
    }).onDelete("cascade"),
    // Cascading: a course gone is no longer taught; its learners' evidence stays.
    foreignKey({
      name: "group_course_course_fk",
      columns: [table.organizationId, table.courseId],
      foreignColumns: [course.organizationId, course.id],
    }).onDelete("cascade"),
    index("group_course_course_idx").on(table.courseId),
  ],
);
