// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Use cases that coordinate `content`, `learning`, `ai`, and `persistence`.
// Workflows spanning modules live here so those modules never call each other.

export { defineCourse, listCourses } from "./courses.ts";
export type { LearnerProgress } from "./learner-progress.ts";
export { readLearnerProgress } from "./learner-progress.ts";
export type { NextObjective } from "./next-objective.ts";
export { chooseNextObjective } from "./next-objective.ts";
export { defineObjectives, listObjectives } from "./objectives.ts";
export { NotPermitted } from "./permission.ts";
export { InvalidEvidence, recordGradedEvidence } from "./record-evidence.ts";
/**
 * Raised by persistence while recording, since only the insert can tell a retry
 * from a disagreement. Named here so callers of `application` need not
 * reach into `persistence` for it.
 */
export { ConflictingEvidence } from "../persistence/index.ts";
