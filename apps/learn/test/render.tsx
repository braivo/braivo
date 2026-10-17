// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { BraivoClient, LearnerProgressSummary, RequestOptions } from "@braivo/server/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";

import type { AppContext } from "../lib/context.ts";
import { createLearnRouter } from "../router.tsx";
import { noProgress } from "./fixtures.ts";

// How the learn app's page tests render it: its real route tree, Braivo and the
// session stubbed, and the steps several test files share.

// Registered in each test file that imports this module, as every page test does.
afterEach(() => {
  // Also for a deadline test that failed before switching back itself.
  vi.useRealTimers();
  cleanup();
  // Where an unfinished answer is kept across a reload.
  sessionStorage.clear();
});

/** A request Braivo never answers: it ends only when its signal aborts, as `fetch` does. */
export function stall(options?: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Lets `ms` pass on fake timers, so that a stalled request reaches its deadline. */
export async function waitOut(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/**
 * The app as a learner reaches it, at `path`, with Braivo and the session
 * stubbed: the route tree is the real one, so gating and loading are too.
 */
export function renderAt(
  path: string,
  options: {
    signedIn: boolean;
    learnerCourses?: BraivoClient["learnerCourses"];
    /** Spanish, `c1`, as 4732, unless given. */
    learnerCourseByNumber?: BraivoClient["learnerCourseByNumber"];
    /** As the app calls it: standings only, without evidence. */
    learnerProgress?: (
      input: { courseId: string; learnerId: string; includeHistory: false },
      options?: RequestOptions,
    ) => Promise<LearnerProgressSummary>;
    nextActivity?: BraivoClient["nextActivity"];
    submitAttempt?: BraivoClient["submitAttempt"];
    /** The organization whose domain serves the app; none unless given. */
    hostOrganization?: BraivoClient["hostOrganization"];
    /** Braivo's answer to who is signed in, in place of `signedIn` and `user`. */
    session?: BraivoClient["session"];
    /** Who is signed in, when `signedIn`. */
    user?: { id: string; name: string };
    /** Better Auth's answer on the installation's host, in place of `signedIn`'s. */
    getSession?: (options?: { fetchOptions?: { signal?: AbortSignal } }) => Promise<unknown>;
    /** What `/login` offers on a learn domain; codes alone unless given. */
    signInSettings?: BraivoClient["signInSettings"];
    /** A learn domain's code sign-in, in place of signing `user` in. */
    signInWithCode?: BraivoClient["signInWithCode"];
  },
) {
  const hostOrganization = options.hostOrganization ?? (async () => undefined);
  const learnerCourses = vi.fn(options.learnerCourses ?? (async () => []));
  const learnerCourseByNumber = vi.fn<BraivoClient["learnerCourseByNumber"]>(
    options.learnerCourseByNumber ??
      (async (number) =>
        number === 4732 ? { id: "c1", number, title: "Spanish", urlLabel: "spanish" } : undefined),
  );
  const learnerProgress = vi.fn(options.learnerProgress ?? (async () => noProgress));
  const nextActivity = vi.fn(options.nextActivity ?? (async () => undefined));
  const submitAttempt = vi.fn(
    options.submitAttempt ??
      (async () => ({ kind: "choice" as const, outcome: "success" as const, correctChoice: 0 })),
  );
  let signedIn = options.signedIn;
  const user = { ...(options.user ?? { id: "ada", name: "Ada Learner" }) };
  const auth = {
    getSession:
      options.getSession ?? (async () => ({ data: signedIn ? { user } : null, error: null })),
    emailOtp: { sendVerificationOtp: async () => ({ error: null }) },
    signIn: {
      emailOtp: vi.fn(async () => {
        signedIn = true;
        return { data: { user }, error: null };
      }),
    },
  } as unknown as AppContext["auth"];
  const signOut = vi.fn(async () => {
    signedIn = false;
  });
  const sendSignInCode = vi.fn<BraivoClient["sendSignInCode"]>(async () => {});
  const signInWithCode = vi.fn<BraivoClient["signInWithCode"]>(
    options.signInWithCode ??
      (async () => {
        signedIn = true;
        return user;
      }),
  );
  const nameAccount = vi.fn<BraivoClient["nameAccount"]>(async (name) => {
    user.name = name;
  });
  const braivo = {
    hostOrganization,
    session: options.session ?? (async () => (signedIn ? user : undefined)),
    signInSettings: options.signInSettings ?? (async () => ({ google: false, legal: null })),
    sendSignInCode,
    signInWithCode,
    nameAccount,
    signOut,
    learnerCourses,
    learnerCourseByNumber,
    learnerProgress,
    nextActivity,
    submitAttempt,
  } as unknown as AppContext["braivo"];
  const visit = vi.fn<AppContext["visit"]>();

  const router = createLearnRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, braivo, visit },
  });
  render(<RouterProvider router={router} />);

  return {
    learnerCourses,
    learnerCourseByNumber,
    learnerProgress,
    nextActivity,
    submitAttempt,
    router,
    signOut,
    visit,
    sendSignInCode,
    signInWithCode,
    nameAccount,
  };
}
