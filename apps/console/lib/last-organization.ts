// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The organization last opened in this browser, where `/` returns (ADR 0004).
 * By ID, since a slug can change and then name another organization. A
 * preference that grants nothing: `/` checks it against the managed list.
 * Unavailable storage just means `/` forgets.
 */
const KEY = "braivo.lastOrganizationId";

export function lastOrganization(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberOrganization(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // See above: forgetting is fine.
  }
}

/**
 * Where `/` opens among the organizations someone manages, listed by name:
 * the one last opened here, else the first; none when they manage none.
 */
export function organizationToOpen<T extends { id: string }>(organizations: T[]): T | undefined {
  const last = lastOrganization();
  return organizations.find(({ id }) => id === last) ?? organizations[0];
}
