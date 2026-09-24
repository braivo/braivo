// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Structured learning content: what a task asks, what a learner sees of it, and
// how an answer to it is graded. Pure, like `learning`; storing and choosing
// tasks belong to `persistence` and `application`. See docs/adr/0015-tasks.md.

export type { Grade, TaskBody, PresentedTask, TaskResponse } from "./task.ts";
export { gradeResponse, parseTaskBody, parseTaskResponse, presentTask } from "./task.ts";
