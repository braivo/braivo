// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Use cases that coordinate `content`, `learning`, `ai`, and `persistence`.
// Workflows spanning modules live here so those modules never call each other.

export type { NextActivity, Passage, SubmittedAttempt } from "./activity.ts";
export { chooseNextActivity, submitAttempt } from "./activity.ts";
export type { ObjectiveReview } from "./review.ts";
export { reviewObjective } from "./review.ts";
export type {
  ReportedAttempt,
  ReportedTask,
  TaskReportInput,
  TaskReportReason,
} from "./task-report.ts";
export {
  dismissReports,
  listReportedTasks,
  MAX_REPORT_NOTE_LENGTH,
  MAX_REPORTS_AT_ONCE,
  parseTaskReport,
  reportAttempt,
} from "./task-report.ts";
export type { FirstAnswersScope, ReportScope } from "../persistence/index.ts";
export type { QuotedCitation } from "./citations.ts";
export { citeSources, InvalidCitation, listObjectiveCitations } from "./citations.ts";
export type { AuthoredCourse, CourseSummary } from "./courses.ts";
export type { CourseStanding, Standing } from "./standing.ts";
export type { AccessKind } from "./access.ts";
export type { Ai } from "./ai.ts";
export type { AiReportRow } from "./ai-report.ts";
export { readAiReport } from "./ai-report.ts";
export type { CourseProgressOverview } from "./course-progress.ts";
export { readCourseProgress } from "./course-progress.ts";
export { AiLimitReached, AiNotEntitled, AiUnavailable, InvalidAiRequest } from "./ai.ts";
export { draftFromSource } from "./drafts.ts";
export {
  activateDomain,
  claimDomain,
  type DnsRecord,
  type DomainClaim,
  type DomainProvisioner,
  DomainRefused,
  type DomainStatus,
  listDomains,
  ProvisioningFailed,
  registerLearnDomain,
  removeDomain,
} from "./domains.ts";
/** What a draft is, and the model failing to give one, named so callers need not reach into `ai`. */
export type { Draft } from "../ai/index.ts";
export { ModelUnavailable } from "../ai/index.ts";
export {
  defineCourse,
  deleteCourse,
  listCourses,
  listLearnerCourses,
  listLearnerCoursesWithStanding,
  publish,
  PublishedCourse,
  readAuthoredCourse,
  setCourseHidden,
  setCourseUrlLabel,
  StalePublication,
  UnpublishedCourse,
} from "./courses.ts";
export { FilesUnavailable, InvalidFile, openFile, readFileText, uploadFile } from "./files.ts";
export { changeGroup, defineGroup, listGroups } from "./groups.ts";
export type { RequestHost } from "./host.ts";
export { readHostOrganization } from "./host.ts";
export type {
  LearnerProgress,
  LearnerProgressReport,
  LearnerProgressSummary,
} from "./learner-progress.ts";
export type { CompletedHandoff } from "./learner-sessions.ts";
export {
  completeHandoff,
  describeHandoff,
  endLearnerSession,
  resumeLearnerSession,
  redeemHandoff,
  startHandoff,
} from "./learner-sessions.ts";
export {
  type AccountErasureCounts,
  type AccountErasureTarget,
  eraseAccount,
  previewAccountErasure,
} from "./erase-account.ts";
export {
  eraseLearnerHistory,
  type ErasureCounts,
  type HistoryErasureTarget,
  previewHistoryErasure,
} from "./erase-history.ts";
export type { ErasureLog } from "./erasure-log.ts";
export { exportLearner } from "./learner-export.ts";
export { readLearnerProgress, withoutHistory } from "./learner-progress.ts";
export type { LearnerSignIn, SentLearnerCode } from "./learner-sign-in.ts";
export { nameNewLearner, sendLearnerSignInCode, signInLearner } from "./learner-sign-in.ts";
export type { NextObjective } from "./next-objective.ts";
export { chooseNextObjective } from "./next-objective.ts";
export { isTimeZone } from "./daily-limit.ts";
export { defineObjectives, InvalidDefinition, listObjectives } from "./objectives.ts";
export {
  listMembers,
  listOrganizations,
  maySetUpOrganization,
  NameRefused,
  readToolsReadLearnerData,
  renameOrganization,
  SetUpRefused,
  setToolsReadLearnerData,
  setUpOrganization,
} from "./organizations.ts";
export {
  type Connection,
  disconnectConnection,
  isConnectionStanding,
  mayRefresh,
  listConnections,
} from "./connections.ts";
export { MemberRefused, removeMember, setMemberRole } from "./members.ts";
export {
  cancelInvitation,
  type CreateInvitationResult,
  type InvitableRole,
  type InvitationBatchResult,
  type InvitationResult,
  type InvitationPage,
  InvitationRefused,
  inviteToOrganization,
  listInvitations,
  type PendingInvitation,
  readInvitationPage,
  resendInvitation,
} from "./invitations.ts";
export { NotPermitted, SignedOut } from "./permission.ts";
export { InvalidEvidence, recordGradedEvidence } from "./record-evidence.ts";
export { addSource, getSource, InvalidSource, listSources } from "./sources.ts";
/** Persistence's shapes the use cases answer, named here as `ConflictingEvidence` is below. */
export type {
  AuthoredTask,
  Citation,
  CourseWriteResult,
  Group,
  GroupChange,
  GroupDefinition,
  Source,
  SourceSummary,
  StoredFile,
  TaskWriteResult,
  ToolsReadLearnerData,
} from "../persistence/index.ts";
export type { CourseTaskList } from "./tasks.ts";
export {
  defineTasks,
  InvalidTask,
  listCourseTasks,
  listObjectiveTasks,
  retireTasks,
} from "./tasks.ts";
/**
 * Raised by persistence while recording, since only the insert can tell a retry
 * from a disagreement. Named here so callers of `application` need not
 * reach into `persistence` for it.
 */
export {
  ConflictingEvidence,
  HistoryErased,
  ConflictingGroupRole,
  ConflictingKey,
  CorrectionPending,
  DeletedCourseKey,
  DuplicateCorrection,
  PublishedTask,
  StaleCorrection,
} from "../persistence/index.ts";
export type { FirstAnswersSummary } from "./first-answers.ts";
export { readFirstAnswers } from "./first-answers.ts";
