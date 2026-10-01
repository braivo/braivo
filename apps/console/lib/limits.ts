// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server's limit on a source's or a course's title. Forms check it before
 * sending, which matters most where what is sent is then locked in, as a
 * reviewed draft is.
 */
export const MAX_TITLE = 500;
