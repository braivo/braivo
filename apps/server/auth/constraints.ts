// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { BetterAuthPlugin } from "better-auth";

/**
 * Constraints Better Auth's own declarations lack, added to its tables so the
 * generated `schema/auth.ts` carries them (ADR 0006). Registered after the
 * plugins that declare these tables: a later plugin's fields replace theirs,
 * and its indexes join them.
 *
 * - `member`: Better Auth checks before adding a member, so two additions that
 *   race could each create a membership; `readOrganizationRoles` reads one
 *   row, so removing someone would leave the other's access behind. And
 *   `group_member` references a membership by it.
 * - `account`: Better Auth finds an account by provider and identity, and
 *   throws on finding two, blocking that Google sign-in for good.
 * - `deviceCode.userId`: deleting an account deletes the codes it approved, so
 *   redeeming one answers `invalid_grant`, not a server error.
 */
export const constraints = {
  id: "braivo-constraints",
  schema: {
    member: {
      fields: {},
      indexes: [
        {
          fields: ["organizationId", "userId"],
          unique: true,
          name: "member_organization_user_uidx",
        },
      ],
    },
    account: {
      fields: {},
      indexes: [
        {
          fields: ["providerId", "accountId"],
          unique: true,
          name: "account_provider_account_uidx",
        },
      ],
    },
    deviceCode: {
      fields: {
        // As the device authorization plugin declares it, plus the reference.
        userId: {
          type: "string",
          required: false,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
      },
    },
  },
} satisfies BetterAuthPlugin;
