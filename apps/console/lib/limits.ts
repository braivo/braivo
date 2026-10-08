// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server's limit on a source's or a course's title. Forms check it before
 * sending, which matters most where what is sent is then locked in, as a
 * reviewed draft is.
 */
export const MAX_TITLE = 500;

/** What the server would refuse in a title, said of `subject` ("the course", "objective 2"). */
export function titleProblem(title: string, subject: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed === "") return `Give ${subject} a title.`;
  if (trimmed.length > MAX_TITLE) {
    return `Keep the title of ${subject} to ${MAX_TITLE} characters.`;
  }
  if (trimmed.includes("\u0000") || !trimmed.isWellFormed()) {
    return `Remove the characters in the title of ${subject} that are not text.`;
  }
}
