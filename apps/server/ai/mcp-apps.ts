// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

export interface McpQuestionCard {
  questionId: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  courseId: string;
}

export interface McpSubmissionResult {
  correct: boolean;
  grade: number;
  citedPassage?: string;
}
