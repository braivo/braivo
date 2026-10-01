// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// The queries Braivo asks of its database. The client, tables, and migrations
// are `@braivo/db`'s; what is asked of them, and in what shape the answers come
// back, is decided here beside the code that needs it.

export type { Citation, CitedPassage } from "./citation.ts";
export { createCitations, readObjectiveCitations, readSourceTexts } from "./citation.ts";
export type { Course } from "./course.ts";
export {
  createCourse,
  readCourseObjectives,
  readCourseOrganization,
  readCourses,
  readLearnerCourses,
} from "./course.ts";
export { recordAiRequest } from "./ai-request.ts";
export { readDomainOrganization } from "./domain.ts";
export { ConflictingEvidence, readLearnerEvidence, recordEvidence } from "./evidence.ts";
export type { StoredFile } from "./file.ts";
export { readFile, recordFile } from "./file.ts";
export { ConflictingKey } from "./key.ts";
export type { Organization } from "./membership.ts";
export { readMemberships, readOrganizationRoles } from "./membership.ts";
export type { Objective } from "./objective.ts";
export {
  createObjectives,
  findObjectivesOutsideOrganization,
  readObjective,
  readObjectives,
  readObjectiveTitles,
} from "./objective.ts";
export { organizationOwnsLearningContent, readOrganizationSlug } from "./organization.ts";
export type { Source, SourceSummary } from "./source.ts";
export { createSource, readSource, readSources } from "./source.ts";
export type { AuthoredTask, CitedTaskPassage, TaskCitation } from "./task.ts";
export {
  ConflictingAttempt,
  createTasks,
  findTasksOutsideOrganization,
  markTasksRetired,
  readObjectiveTasks,
  readTaskCitations,
  readCourseTask,
  readNextTask,
  readObjectivesWithTasks,
  recordAttempt,
  RestingTask,
  RetiredTask,
} from "./task.ts";
