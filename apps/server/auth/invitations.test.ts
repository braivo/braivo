// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { APIError } from "better-auth/api";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { describe, expect, test } from "vite-plus/test";

import { NotPermitted } from "../application/permission.ts";
import type { Auth } from "./auth.ts";
import { createInvitation } from "./invitations.ts";

/** An auth whose invitation endpoint refuses with `error`. */
const refusing = (error: unknown) =>
  ({
    api: {
      createInvitation: async () => {
        throw error;
      },
    },
  }) as unknown as Auth;

const input = {
  headers: new Headers(),
  organizationId: "org",
  email: "ada@example.com",
  role: "author" as const,
  locale: "en" as const,
};

describe("createInvitation", () => {
  test("refuses as Braivo's check does when the session ended or stopped administering since", async () => {
    for (const status of ["UNAUTHORIZED", "FORBIDDEN"] as const) {
      await expect(
        createInvitation(refusing(new APIError(status, { code: "ANY" })), input),
      ).rejects.toBeInstanceOf(NotPermitted);
    }
  });

  test("refuses so when the actor was removed since, as Better Auth reports it", async () => {
    const removed = APIError.from("BAD_REQUEST", ORGANIZATION_ERROR_CODES.MEMBER_NOT_FOUND);
    await expect(createInvitation(refusing(removed), input)).rejects.toBeInstanceOf(NotPermitted);
  });

  test("passes on anything else unforeseen", async () => {
    const error = new APIError("INTERNAL_SERVER_ERROR");
    await expect(createInvitation(refusing(error), input)).rejects.toBe(error);
  });
});
