// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Organization } from "@braivo/server/client";
import { createMemoryHistory, type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, onTestFinished, vi } from "vite-plus/test";

import type { AppContext } from "../lib/context.ts";
import { createConsoleRouter } from "../router.tsx";
import { members, courseProgress, school } from "./fixtures.ts";

// How the console's page tests render it: its real route tree, Braivo and Better
// Auth stubbed, and the steps and checks several test files share.

// Registered in each test file that imports this module, as every page test does.
afterEach(() => {
  // First: a test failing on fake timers would leave them to the cleanup, and the next test.
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
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

/** Opens the header's account menu by keyboard: Radix's menus ignore a bare click. */
export async function openAccountMenu(): Promise<HTMLElement> {
  fireEvent.keyDown(await screen.findByRole("button", { name: /^Account: / }), { key: "Enter" });
  return screen.findByRole("menu");
}

/** Lets `ms` pass on fake timers, so that a stalled request reaches its deadline. */
export async function waitOut(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/**
 * The console as an owner reaches it, with Braivo and Better Auth stubbed. The
 * route tree is the real one. The owner manages `school` alone unless a test
 * says otherwise.
 */
export function renderAt(
  path: string,
  stubs: {
    signedIn?: boolean;
    /** The account's name, once signed in: none for one an emailed code just made. */
    name?: string;
    braivo?: object;
    organizations?: Organization[];
    /** Better Auth's device flow: `device(query)`, with `approve` and `deny` on it. */
    device?: object;
    /** Better Auth's own requests, `$fetch(path, options)`: the OAuth consent's. */
    $fetch?: object;
    /** Better Auth's session read, in place of one answering at once. */
    getSession?: () => Promise<unknown>;
    /** The browser's, whose Back a blocker can stop, unlike a memory history's; `path` is then ignored. */
    history?: RouterHistory;
  } = {},
) {
  // `u1`, as in `members`.
  const account = { id: "u1", name: stubs.name ?? "Olive Owner", email: "olive@example.com" };
  let signedIn = stubs.signedIn ?? true;
  const auth = {
    getSession: async () => ({ data: signedIn ? { user: { ...account } } : null, error: null }),
    emailOtp: { sendVerificationOtp: vi.fn(async () => ({ error: null })) },
    signIn: {
      emailOtp: vi.fn(async () => {
        signedIn = true;
        return { data: { user: { ...account } }, error: null };
      }),
      social: vi.fn(async (): Promise<{ error: { status: number } | null }> => ({ error: null })),
      // A reviewer's password (ADR 0018): `REVIEWER_PASSWORD` alone signs in.
      email: vi.fn(async ({ password }: { password: string }) => {
        if (password !== REVIEWER_PASSWORD) return { data: null, error: { status: 401 } };
        signedIn = true;
        return { data: { user: { ...account } }, error: null };
      }),
    },
    updateUser: vi.fn(
      async ({ name }: { name: string; fetchOptions?: { signal?: AbortSignal } }) => {
        account.name = name;
        return { error: null };
      },
    ),
    signOut: vi.fn(async () => {
      signedIn = false;
      return { error: null };
    }),
    device: stubs.device,
    $fetch: stubs.$fetch,
    ...(stubs.getSession && { getSession: stubs.getSession }),
  };
  const visit = vi.fn<AppContext["visit"]>();

  const router = createConsoleRouter({
    history: stubs.history ?? createMemoryHistory({ initialEntries: [path] }),
    context: {
      auth: auth as unknown as AppContext["auth"],
      braivo: {
        listOrganizations: async () => stubs.organizations ?? [school],
        listMembers: async () => members,
        listGroups: async () => [],
        listObjectives: async () => [],
        listDomains: async () => ({
          domains: [{ hostname: "example.braivo.app" }],
          claims: [],
          canAdd: false,
        }),
        courseProgress,
        signInSettings: async () => ({ google: false, legal: null }),
        organizationSetup: async () => null,
        ...stubs.braivo,
      } as unknown as AppContext["braivo"],
      visit,
    },
  });
  render(<RouterProvider router={router} />);

  return { auth, router, visit };
}

/**
 * Signs in from `/login` as a person would: an email, then the code mailed to
 * it, whose last digit submits it.
 */
export async function signInWithCode() {
  fireEvent.change(await screen.findByLabelText("Email address"), {
    target: { value: "owner@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
  fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
}

export const REVIEWER_PASSWORD = "a reviewer's password, long enough";

/** Signs in from `/login?method=password` as a reviewer would, with `password`. */
export async function signInWithPassword(password = REVIEWER_PASSWORD) {
  fireEvent.change(await screen.findByLabelText("Email address"), {
    target: { value: "reviewer@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

/**
 * A proxy's timeout told as one: that the request may have counted, what to
 * change, and not to try again unchanged.
 */
export function expectProxyTimeoutExplained(alert: HTMLElement) {
  expect(alert.textContent).toMatch(/may still use one of this month's AI requests/);
  expect(alert.textContent).toMatch(/Less material may finish sooner/);
  expect(alert.textContent).toMatch(/up to five minutes/);
  expect(alert.textContent).not.toMatch(/Try again/);
}

/** Where drafting with the person's own AI app is offered, a link to connecting one, in a new tab. */
export function expectAiAppGuide(scope: HTMLElement = document.body) {
  const link = within(scope).getByRole("link", {
    name: "your own AI app, such as Claude or ChatGPT",
  });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/braivo/braivo/blob/main/docs/guides/assistants.md",
  );
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
}

/** A pending action's button: locked, but never disabled, which would drop the focus. */
export function expectLockedInFocus(button: HTMLElement) {
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.matches(":disabled")).toBe(false);
  expect(document.activeElement).toBe(button);
}

/** The owner's answer when leaving a draft under review asks first; Happy DOM has no `confirm`. */
export function answerLeaving(leave: boolean) {
  const confirm = vi.fn((_message?: string) => leave);
  vi.stubGlobal("confirm", confirm);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return confirm;
}
