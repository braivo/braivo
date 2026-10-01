// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { deviceAuthorizationClient, organizationClient } from "better-auth/client/plugins";

/**
 * Better Auth, with the organizations content owners work in, and the device
 * flow through which they let their own tools act as them (ADR 0022).
 */
export function createConsoleAuth(baseURL: string) {
  return createBrowserAuth({
    baseURL,
    plugins: [organizationClient(), deviceAuthorizationClient()],
  });
}

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;
