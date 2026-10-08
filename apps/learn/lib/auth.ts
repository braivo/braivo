// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth, type SessionAuth } from "@braivo/auth-client";
import type { BraivoClient, SessionUser } from "@braivo/server/client";
import { emailOTPClient } from "better-auth/client/plugins";

import { READ_DEADLINE_MS, withDeadline } from "./deadline.ts";

/**
 * Better Auth, signing in by a code sent by email: only on the installation's
 * own host, which is where the learn app runs in development. A learn domain
 * signs in by handoff from that host instead (ADR 0018), and has no Better Auth.
 */
export function createLearnAuth(baseURL: string) {
  return createBrowserAuth({ baseURL, plugins: [emailOTPClient()] });
}

export type LearnAuth = ReturnType<typeof createLearnAuth>;

/**
 * Braivo's session for this host, whichever it is, in the shape
 * `requireSession` reads: a request that got no answer, in time or at all, is
 * an error, not a sign-out.
 */
export function asSessionAuth(braivo: BraivoClient): SessionAuth<SessionUser> {
  return {
    getSession: () =>
      braivo.session({ signal: withDeadline(undefined, READ_DEADLINE_MS) }).then(
        (user) => ({ data: user ? { user } : null, error: null }),
        (error: unknown) => ({ data: null, error: { message: String(error) } }),
      ),
  };
}
