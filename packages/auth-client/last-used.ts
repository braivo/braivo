// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The area of the installation's origin someone last used, which a bare `/`
 * resumes (ADR 0059): My learning, or an organization's console, by ID, since
 * a slug can change and then name another. Written by both apps on that
 * origin, so one key for both; per account, so a shared browser resumes each
 * person's own. A preference that grants nothing: `/` checks an organization
 * against those still theirs. Unavailable storage just means `/` forgets.
 */
export type LastUsed = { area: "learning" } | { area: "console"; organizationId: string };

const key = (userId: string) => `braivo.lastUsed.${userId}`;

export function lastUsed(userId: string): LastUsed | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return undefined;
    const { area, organizationId } = stored as Record<string, unknown>;
    if (area === "learning") return { area };
    if (area === "console" && typeof organizationId === "string") return { area, organizationId };
  } catch {
    // Unreadable, or not ours: as if forgotten.
  }
  return undefined;
}

export function rememberLastUsed(userId: string, used: LastUsed): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(used));
  } catch {
    // See above: forgetting is fine.
  }
}
