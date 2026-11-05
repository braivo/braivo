// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { InvitableRole } from "@braivo/server/client";

/**
 * An invitation not yet sent, as typed: its addresses and their role, one
 * intended action, so neither comes back without the other.
 */
export type InvitationDraft = { emails: string; role: InvitableRole };

/**
 * Members' unsent invitations, per account and organization, kept outside the
 * page: a reread that fails replaces the page, and Try again mounts it
 * afresh, so addresses pasted there would otherwise be lost (docs/apps.md).
 * For as long as the console stays open; another account on the same device
 * never reads one, and one emptied is forgotten, its role with it.
 */
const drafts = new Map<string, InvitationDraft>();

export const invitationDrafts = {
  get: (userId: string, organizationId: string) => drafts.get(`${userId} ${organizationId}`),
  set(userId: string, organizationId: string, draft: InvitationDraft) {
    const key = `${userId} ${organizationId}`;
    if (draft.emails.trim()) drafts.set(key, draft);
    else drafts.delete(key);
  },
  /** For tests, each starting with none. */
  clear: () => drafts.clear(),
};
