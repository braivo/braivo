// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type BraivoClient } from "@braivo/server/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { routeTree } from "./routeTree.gen.ts";

afterEach(cleanup);

const activity: Activity = {
  decision: { objectiveId: "o1", modelVersion: "v1", intent: "introduce" },
  task: {
    id: "t1",
    kind: "choice",
    prompt: "Past tense of 'hablar'?",
    options: ["hablé", "hablo"],
  },
};

/**
 * The app as a learner reaches it, at `path`, with Braivo and the session
 * stubbed: the route tree is the real one, so gating and loading are too.
 */
function renderAt(
  path: string,
  options: {
    signedIn: boolean;
    nextActivity?: BraivoClient["nextActivity"];
    submitAttempt?: BraivoClient["submitAttempt"];
  },
) {
  const nextActivity = vi.fn(options.nextActivity ?? (async () => undefined));
  const submitAttempt = vi.fn(
    options.submitAttempt ?? (async () => ({ outcome: "success" as const, answer: 0 })),
  );
  const auth = {
    getSession: async () => ({
      data: options.signedIn ? { user: { name: "Ada Learner" } } : null,
      error: null,
    }),
  } as unknown as AppContext["auth"];
  const braivo = { nextActivity, submitAttempt } as unknown as AppContext["braivo"];

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, braivo },
  });
  render(<RouterProvider router={router} />);

  return { nextActivity, submitAttempt, router };
}

describe("the learn app", () => {
  test("sends a signed-out learner to sign in, and asks Braivo nothing", async () => {
    const { nextActivity, router } = renderAt("/courses/c1", { signedIn: false });

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ redirect: "/courses/c1" });
    expect(nextActivity).not.toHaveBeenCalled();
  });

  test("asks the task, grades the answer, and moves on", async () => {
    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => ({ outcome: "failure", answer: 0, explanation: "Preterite." }),
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledWith("c1", { signal: expect.any(AbortSignal) });

    fireEvent.click(screen.getByRole("button", { name: "hablo" }));

    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(screen.getByText("Preterite.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Correct/ })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledWith(
      { courseId: "c1", id: expect.any(String), taskId: "t1", response: { choice: 1 } },
      { signal: expect.any(AbortSignal) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // The next activity is loaded, starts unanswered, and has the focus
    // Continue had, so a keyboard or screen-reader learner lands on it.
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "hablo" })).toBeTruthy();
    expect(screen.queryByText("Not quite")).toBeNull();
    expect(document.activeElement?.tagName).toBe("SECTION");
    expect(document.activeElement?.textContent).toContain("Past tense of 'hablar'?");
  });

  test("lets a learner answer again when the answer could not be sent", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ outcome: "success", answer: 0 });
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByText("Your answer could not be sent. Choose again.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "hablé" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Correct");

    // A resubmission is the same attempt, so Braivo records it once.
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0].id).toBe(first![0].id);
  });

  test("moves on when the attempt was answered already, its grade lost on the way back", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(undefined);
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => {
        throw new BraivoError(409, "conflict");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Nothing to practise right now")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Your answer could not be sent. Choose again.")).toBeNull();
  });

  test("sends a learner whose session ended to sign in, rather than asking them to retry", async () => {
    let signedIn = true;
    const auth = {
      getSession: async () => ({
        data: signedIn ? { user: { name: "Ada Learner" } } : null,
        error: null,
      }),
    } as unknown as AppContext["auth"];
    const braivo = {
      nextActivity: async () => activity,
      submitAttempt: async () => {
        signedIn = false;
        throw new BraivoError(401, "no session");
      },
    } as unknown as AppContext["braivo"];
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/courses/c1"] }),
      context: { auth, braivo },
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  test("says when there is nothing to practise, without claiming the learner is caught up", async () => {
    renderAt("/courses/c1", { signedIn: true });

    expect(await screen.findByText("Nothing to practise right now")).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-slot")).toBe("empty");
  });

  test("reads a course Braivo will not show as not found, not as nothing to practise", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => {
        throw new BraivoError(404, "not found");
      },
    });

    expect(
      await screen.findByText("This course does not exist, or is not one of yours."),
    ).toBeTruthy();
  });
});
