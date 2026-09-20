// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { organizationClient } from "better-auth/client/plugins";

/** Better Auth, with the organizations content owners work in. */
export function createConsoleAuth(baseURL: string) {
  return createBrowserAuth({ baseURL, plugins: [organizationClient()] });
}

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;
