// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Each role as a school says it: a `member` is a learner, membership being enrollment (access-23). */
const ROLE_NAMES = {
  owner: msg`Owner`,
  admin: msg`Admin`,
  author: msg`Author`,
  member: msg`Learner`,
} as const;

/** Roles as one phrase in the reader's language, "Owner and Admin"; one not named here as stored. */
export function sayRoles(i18n: I18n, roles: readonly string[]) {
  return new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
    roles.map((role) =>
      Object.hasOwn(ROLE_NAMES, role) ? i18n._(ROLE_NAMES[role as keyof typeof ROLE_NAMES]) : role,
    ),
  );
}
