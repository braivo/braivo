// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Use cases that coordinate `content`, `learning`, `ai`, and `persistence`.
// Workflows spanning modules live here so those modules never call each other.

export type { NextActivity, Passage, SubmittedAttempt } from "./activity.ts";
export { chooseNextActivity, submitAttempt } from "./activity.ts";
export type { QuotedCitation } from "./citations.ts";
export { citeSources, InvalidCitation, listObjectiveCitations } from "./citations.ts";
export type { AuthoredCourse } from "./courses.ts";
export type { Ai } from "./ai.ts";
export type { CourseProgressOverview } from "./course-progress.ts";
export { readCourseProgress } from "./course-progress.ts";
export { AiLimitReached, AiNotEntitled, AiUnavailable, InvalidAiRequest } from "./ai.ts";
export { draftFromSource } from "./drafts.ts";
export { DomainRefused, registerLearnDomain } from "./domains.ts";
/** What a draft is, and the model failing to give one, named so callers need not reach into `ai`. */
export type { Draft } from "../ai/index.ts";
export { ModelUnavailable } from "../ai/index.ts";
export { defineCourse, listCourses, listLearnerCourses, readAuthoredCourse } from "./courses.ts";
export { FilesUnavailable, InvalidFile, openFile, readFileText, uploadFile } from "./files.ts";
export type { RequestHost } from "./host.ts";
export { readHostOrganization } from "./host.ts";
export type { LearnerProgress, LearnerProgressReport } from "./learner-progress.ts";
export type { CompletedHandoff } from "./learner-sessions.ts";
export {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  resumeLearnerSession,
  redeemHandoff,
  startHandoff,
} from "./learner-sessions.ts";
export { readLearnerProgress } from "./learner-progress.ts";
export type { NextObjective } from "./next-objective.ts";
export { chooseNextObjective } from "./next-objective.ts";
export { defineObjectives, InvalidDefinition, listObjectives } from "./objectives.ts";
export {
  listManagedOrganizations,
  listMembers,
  SetUpRefused,
  setUpOrganization,
} from "./organizations.ts";
export { NotPermitted } from "./permission.ts";
export { InvalidEvidence, recordGradedEvidence } from "./record-evidence.ts";
export { addSource, getSource, InvalidSource, listSources } from "./sources.ts";
/** What `getSource` and `listSources` answer, named here as `ConflictingEvidence` is below. */
export type {
  AuthoredTask,
  Citation,
  Source,
  SourceSummary,
  StoredFile,
} from "../persistence/index.ts";
export { defineTasks, InvalidTask, listObjectiveTasks, retireTasks } from "./tasks.ts";
/**
 * Raised by persistence while recording, since only the insert can tell a retry
 * from a disagreement. Named here so callers of `application` need not
 * reach into `persistence` for it.
 */
export { ConflictingEvidence, ConflictingKey, StaleCorrection } from "../persistence/index.ts";
