// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { deviceAuthorizationClient, emailOTPClient } from "better-auth/client/plugins";

/**
 * Better Auth, signing in by a code sent by email (ADR 0018), with the device
 * flow through which content owners let their own tools act as them (ADR 0022).
 * Organizations and their members come from Braivo's API, which checks the
 * role.
 */
export function createConsoleAuth(baseURL: string) {
  return createBrowserAuth({
    baseURL,
    plugins: [emailOTPClient(), deviceAuthorizationClient()],
  });
}

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;
