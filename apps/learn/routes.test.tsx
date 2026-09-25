// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type BraivoClient, type Grade } from "@braivo/server/client";
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

const anotherActivity: Activity = {
  decision: {
    objectiveId: "o1",
    modelVersion: "v1",
    intent: "reteach",
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
  },
  task: { id: "t2", kind: "choice", prompt: "Past tense of 'comer'?", options: ["comí", "como"] },
};

/**
 * The app as a learner reaches it, at `path`, with Braivo and the session
 * stubbed: the route tree is the real one, so gating and loading are too.
 */
function renderAt(
  path: string,
  options: {
    signedIn: boolean;
    learnerCourses?: BraivoClient["learnerCourses"];
    nextActivity?: BraivoClient["nextActivity"];
    submitAttempt?: BraivoClient["submitAttempt"];
  },
) {
  const learnerCourses = vi.fn(options.learnerCourses ?? (async () => []));
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
  const braivo = { learnerCourses, nextActivity, submitAttempt } as unknown as AppContext["braivo"];

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, braivo },
  });
  render(<RouterProvider router={router} />);

  return { learnerCourses, nextActivity, submitAttempt, router };
}

describe("the learn app", () => {
  test("sends a signed-out learner to sign in, and asks Braivo nothing", async () => {
    const { nextActivity, router } = renderAt("/courses/c1", { signedIn: false });

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ redirect: "/courses/c1" });
    expect(nextActivity).not.toHaveBeenCalled();
  });

  test("lists the learner's courses, each a way into it", async () => {
    const { learnerCourses, router } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
      nextActivity: async () => activity,
    });

    const link = await screen.findByRole("link", { name: "Spanish" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(learnerCourses).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    fireEvent.click(link);

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/courses/c1");
  });

  test("tells a learner with no courses so", async () => {
    renderAt("/", { signedIn: true });

    expect(await screen.findByText("No courses yet")).toBeTruthy();
  });

  test("asks the task, grades the answer, and moves on", async () => {
    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
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
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText("Not quite")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Past tense of 'comer'?" }),
    );
  });

  test.each([
    ["was lost", new TypeError("Failed to fetch")],
    ["failed on the server", new BraivoError(500, "server error")],
  ])("resends the same answer when it %s", async (_, failure) => {
    let graded!: (grade: Grade) => void;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(new Promise((resolve) => (graded = resolve)));
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    const option = await screen.findByRole("button", { name: "hablé" });
    fireEvent.click(option);
    // Locked while sending, but never disabled, which would drop the focus a
    // keyboard learner needs. (jsdom keeps focus on a disabled button, so this
    // pins the cause.)
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.matches(":disabled")).toBe(false);
    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    // Marked as the learner's answer, with no spinner, since nothing is on its way.
    expect(option.textContent).toBe("habléYour answer");
    expect(screen.queryByRole("status")).toBeNull();

    // The options stay locked on the answer given: another would conflict
    // with it if it was recorded.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    const retry = screen.getByRole("button", { name: "Send again" });
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    fireEvent.click(retry);
    // Held while the resend is on its way, and focused still.
    expect(retry.textContent).toBe("Sending…");
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry.matches(":disabled")).toBe(false);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(2);

    graded({ outcome: "success", answer: 0 });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");

    // The same attempt and answer, so Braivo records it once and answers its
    // grade if the first one arrived.
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test("holds Continue while the next activity loads, so a second press does not restart it", async () => {
    let loaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockReturnValueOnce(new Promise((resolve) => (loaded = resolve)));
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(next);
    fireEvent.click(next);

    expect(next.textContent).toBe("Loading…");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.matches(":disabled")).toBe(false);
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));

    loaded(undefined);
    expect(await screen.findByText("Nothing to practise right now")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  test.each([400, 403, 413])(
    "gives up on an answer Braivo refuses with %i, rather than inviting another choice",
    async (status) => {
      renderAt("/courses/c1", {
        signedIn: true,
        nextActivity: async () => activity,
        submitAttempt: async () => {
          throw new BraivoError(status, "refused");
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

      const notice = await screen.findByRole("region", { name: "Something went wrong." });
      expect(document.activeElement).toBe(notice);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

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

  test("says when a just-answered task comes back, and asks again then", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce({ retryAfter: 0.05 })
      .mockResolvedValueOnce(activity);
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    const notice = await screen.findByRole("region", { name: "Take a short break" });
    expect(document.activeElement).toBe(notice);

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  test("rests a task answered moments ago elsewhere, rather than asking again", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce({ retryAfter: 600 });
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => {
        throw new BraivoError(409, "resting");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Take a short break")).toBeTruthy();
  });

  test("says when there is nothing to practise, without claiming the learner is caught up", async () => {
    renderAt("/courses/c1", { signedIn: true });

    const notice = await screen.findByRole("region", { name: "Nothing to practise right now" });
    expect(document.activeElement).toBe(notice);
  });

  test("sends one answer, however many options are tapped while it is on its way", async () => {
    let graded!: (grade: Grade) => void;
    const submitAttempt = vi.fn<BraivoClient["submitAttempt"]>(
      () => new Promise((resolve) => (graded = resolve)),
    );
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    graded({ outcome: "success", answer: 0 });

    expect((await screen.findByRole("alert")).textContent).toBe("Correct");
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("offers to load the course again when loading it failed", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(activity);
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
  });

  test("waits for a fresh activity when the learner returns to a course", async () => {
    let loaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockReturnValueOnce(new Promise((resolve) => (loaded = resolve)));
    const { router } = renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await screen.findByRole("button", { name: "Continue" });
    await router.navigate({ to: "/" });
    void router.navigate({ to: "/courses/$courseId", params: { courseId: "c1" } });

    // What comes next depends on that answer, so the old question, which would
    // mount unanswered, must not be shown while the next one loads.
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Past tense of 'hablar'?")).toBeNull();

    loaded(undefined);
    expect(await screen.findByText("Nothing to practise right now")).toBeTruthy();
  });

  test("offers to load again when loading the next activity failed", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(undefined);
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Nothing to practise right now")).toBeTruthy();
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
