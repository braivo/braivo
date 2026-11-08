// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { lastUsed } from "@braivo/auth-client";

/**
 * Which of the organizations someone works in, listed by name, to open: the
 * one whose console they last used in this browser (ADR 0059), else the
 * first school, as a personal organization is none; none when there is no
 * school. A preference that grants nothing: only one still listed is opened.
 */
export function organizationToOpen<T extends { id: string; personal: boolean }>(
  organizations: T[],
  userId: string,
): T | undefined {
  const last = lastUsed(userId);
  const remembered = last?.area === "console" ? last.organizationId : undefined;
  return (
    organizations.find(({ id }) => id === remembered) ??
    organizations.find(({ personal }) => !personal)
  );
}
