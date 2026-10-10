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
export { insertLearnDomain, readDomainOrganization, readLearnDomain } from "./domain.ts";
export {
  ConflictingEvidence,
  readLearnerEvidence,
  readMembersEvidence,
  recordEvidence,
} from "./evidence.ts";
export {
  deleteLearnerSession,
  insertHandoff,
  issueHandoffCode,
  readHandoff,
  readLearnerSession,
  spendHandoffCode,
  renewLearnerSession,
} from "./learner-session.ts";
export type { CheckedCode } from "./learner-sign-in-code.ts";
export {
  checkLearnerSignInCode,
  nameUnnamedUser,
  spendLearnerSignInCode,
  storeLearnerSignInCode,
} from "./learner-sign-in-code.ts";
export type { StoredFile } from "./file.ts";
export { readFile, recordFile } from "./file.ts";
export { ConflictingKey } from "./key.ts";
export type { ListedOrganization, Member, Organization } from "./membership.ts";
export {
  deleteNewOrganization,
  readMembers,
  readMemberships,
  readOrganizationRoles,
} from "./membership.ts";
export type { Objective } from "./objective.ts";
export {
  createObjectives,
  findObjectivesOutsideOrganization,
  readObjective,
  readObjectives,
  readObjectiveTitles,
} from "./objective.ts";
export {
  organizationOwnsLearningContent,
  readOrganizationBySlug,
  readOrganizationSlug,
} from "./organization.ts";
export { claimSignInCode } from "./sign-in-code.ts";
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
  readTaskObjective,
  readCourseTask,
  readNextTask,
  readObjectivesWithTasks,
  recordAttempt,
  replaceTask,
  RestingTask,
  RetiredTask,
  StaleCorrection,
} from "./task.ts";
