// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

/**
 * Better Auth, with the device flow through which content owners let their own
 * tools act as them (ADR 0022). Organizations and their members come from
 * Braivo's API, which checks the role.
 */
export function createConsoleAuth(baseURL: string) {
  return createBrowserAuth({
    baseURL,
    plugins: [deviceAuthorizationClient()],
  });
}

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;
