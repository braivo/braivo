// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { createBrowserAuth, type SessionAuth, type SignInAuth } from "@braivo/auth-client";
import { BraivoError, type BraivoClient, type SessionUser } from "@braivo/server/client";
import { emailOTPClient } from "better-auth/client/plugins";

import { READ_DEADLINE_MS, withDeadline } from "./deadline.ts";

/**
 * Better Auth, signing in by a code sent by email: only on the installation's
 * own host, which is where the learn app runs in development. A learn domain
 * has no Better Auth: it signs in through `learnDomainAuth` (ADR 0018).
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

/**
 * The shared sign-in form's requests, on a learn domain: its own codes,
 * which sign in there alone, and Google by a handoff through the
 * installation's origin, Google's one callback, back to `redirect`. Answered
 * as Better Auth's client answers, a refusal as its `code` and status; a
 * request with no answer still throws.
 */
export function learnDomainAuth(
  braivo: BraivoClient,
  visit: (href: string) => void,
  redirect: string,
): SignInAuth {
  async function answered<Data>(request: Promise<Data>) {
    try {
      return { data: await request, error: null };
    } catch (thrown) {
      if (!(thrown instanceof BraivoError)) throw thrown;
      const { status, code } = thrown;
      // Named as Better Auth's, which the form reads as signed out.
      return { data: null, error: { status, code: status === 401 ? "UNAUTHORIZED" : code } };
    }
  }

  return {
    emailOtp: {
      sendVerificationOtp: ({ email, fetchOptions }) =>
        answered(braivo.sendSignInCode(email, fetchOptions)),
    },
    signIn: {
      emailOtp: async ({ email, otp, fetchOptions }) =>
        answered(braivo.signInWithCode(email, otp, fetchOptions).then((user) => ({ user }))),
      social: async () => {
        visit(`/api/session/sign-in?${new URLSearchParams({ redirect, provider: "google" })}`);
        // Leaving, as Better Auth's client does once Google's address is known.
        return { error: null };
      },
    },
    // Named already, by this request's lost answer or another tab: done, as
    // asking again would be refused every time.
    updateUser: async ({ name, fetchOptions }) => {
      const result = await answered(braivo.nameAccount(name, fetchOptions));
      return result.error?.code === "ALREADY_NAMED" ? { data: null, error: null } : result;
    },
  };
}
