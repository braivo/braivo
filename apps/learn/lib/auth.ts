// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth } from "@braivo/auth-client";
import { emailOTPClient } from "better-auth/client/plugins";

/**
 * Better Auth, signing in by a code sent by email: here on the learn domain
 * until ADR 0018's handoff signs learners in on the installation's origin.
 */
export function createLearnAuth(baseURL: string) {
  return createBrowserAuth({ baseURL, plugins: [emailOTPClient()] });
}

export type LearnAuth = ReturnType<typeof createLearnAuth>;
