// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type BraivoClient } from "@braivo/server/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import type { AppContext } from "../lib/context.ts";
import {
  ANSWER_DEADLINE_MS,
  OPTIONAL_READ_DEADLINE_MS,
  READ_DEADLINE_MS,
} from "../lib/deadline.ts";
import { createLearnRouter } from "../router.tsx";
import { SPANISH_ID, typedActivity, activity, anotherActivity, noProgress } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

describe("the learn app", () => {
  test("shows an answer's feedback after a reload while it was on its way, sending the same attempt", async () => {
    const before = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();

    const { nextActivity, submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      // The answer was recorded, so Braivo has moved on.
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => ({
        kind: "choice",
        outcome: "failure",
        correctChoice: 0,
        explanation: "Preterite.",
      }),
    });

    // The task answered, not the next one, graded as before the reload.
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("Preterite.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Correct/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablo.*Your answer/ })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    expect(submitAttempt.mock.calls[0]![0]).toEqual(before.submitAttempt.mock.calls[0]![0]);
    expect(nextActivity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    cleanup();

    // Continued past, it is not sent again.
    const after = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
    });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(after.submitAttempt).not.toHaveBeenCalled();
  });

  test("after a reload, resends an answer that could not be confirmed, and offers to send it again", async () => {
    const lost = async () => {
      throw new TypeError("Failed to fetch");
    };
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: lost,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    cleanup();

    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce({ kind: "choice", outcome: "success", correctChoice: 0 });
    renderAt("/c/4732", { signedIn: true, submitAttempt });

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Your answer/ })).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Send again" });
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test.each([
    ["a typed answer", { text: "ben" }, "Not quite"],
    ["Show answer", { reveal: true }, "Here it is"],
  ] as const)(
    "after a reload, resends %s that could not be confirmed, exactly",
    async (_case, response, title) => {
      const { submitAttempt: lost } = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => typedActivity,
        submitAttempt: async () => {
          throw new TypeError("Failed to fetch");
        },
      });
      if ("text" in response) {
        const field = await screen.findByRole("textbox", { name: "I am tired: Ich ___ müde." });
        fireEvent.change(field, { target: { value: response.text } });
        fireEvent.click(screen.getByRole("button", { name: "Check" }));
      } else {
        fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));
      }
      expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
      cleanup();

      const submitAttempt = vi.fn<BraivoClient["submitAttempt"]>(async () => ({
        kind: "typed",
        outcome: "failure",
        correctAnswer: "bin",
      }));
      renderAt("/c/4732", { signedIn: true, submitAttempt });

      expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
      // The same attempt, ID and all, so Braivo records it once.
      expect(lost.mock.calls[0]![0]!.response).toEqual(response);
      expect(submitAttempt.mock.calls[0]![0]).toEqual(lost.mock.calls[0]![0]);
      expect(within(screen.getByRole("alert")).getByText(title)).toBeTruthy();
      expect(within(screen.getByRole("alert")).getByText("The answer: bin")).toBeTruthy();
    },
  );

  test("offers to send an answer again when Braivo does not answer in time", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockImplementationOnce((_input, options) => stall(options))
      .mockResolvedValueOnce({ kind: "choice", outcome: "success", correctChoice: 0 });
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });
    const option = await screen.findByRole("button", { name: "hablé" });

    vi.useFakeTimers();
    fireEvent.click(option);
    await waitOut(ANSWER_DEADLINE_MS - 1);
    expect(screen.queryByText("Your answer could not be confirmed.")).toBeNull();
    await waitOut(1);
    vi.useRealTimers();

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test("after a reload, offers to send again an answer whose resend Braivo does not answer in time", async () => {
    const before = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();

    vi.useFakeTimers();
    renderAt("/c/4732", {
      signedIn: true,
      submitAttempt: (_input, options) => stall(options),
    });
    await waitOut(ANSWER_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Your answer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
  });

  test.each([
    ["the brand", { hostOrganization: (options) => stall(options) }],
    ["the summary", { learnerProgress: (_input, options) => stall(options) }],
    ["the title", { learnerCourses: (options) => stall(options) }],
  ] satisfies [string, Partial<BraivoClient>][])(
    "asks the question without %s when Braivo does not answer it in time",
    async (_, stubs) => {
      vi.useFakeTimers();
      // By ID, as the title is read from the list then.
      renderAt(`/c/${SPANISH_ID}`, {
        signedIn: true,
        nextActivity: async () => activity,
        ...stubs,
      });
      // Held back meanwhile, so the page does not shift when it arrives.
      await waitOut(OPTIONAL_READ_DEADLINE_MS - 1);
      expect(screen.queryByText("Past tense of 'hablar'?")).toBeNull();
      await waitOut(1);
      vi.useRealTimers();

      expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    },
  );

  test("gives the question its own deadline, not the shorter one of what it shows without", async () => {
    vi.useFakeTimers();
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: (_input, options) => stall(options),
      // Slower than the summary's deadline, within its own.
      nextActivity: (_courseId, options) =>
        Promise.race([
          new Promise<Activity>((resolve) => setTimeout(() => resolve(activity), 5_000)),
          stall(options),
        ]),
    });
    await waitOut(5_000);
    vi.useRealTimers();

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
  });

  test.each([
    [
      "the next question",
      {
        nextActivity: vi
          .fn<BraivoClient["nextActivity"]>()
          .mockResolvedValueOnce(activity)
          .mockImplementationOnce((_courseId, options) => stall(options))
          .mockResolvedValue(anotherActivity),
      },
      // The course page's Try again reloads the course alone.
      1,
    ],
    [
      "the session",
      {
        nextActivity: vi
          .fn<BraivoClient["nextActivity"]>()
          .mockResolvedValueOnce(activity)
          .mockResolvedValue(anotherActivity),
        session: vi
          .fn<BraivoClient["session"]>()
          .mockResolvedValueOnce({ id: "ada", name: "Ada Learner" })
          .mockImplementationOnce((options) => stall(options))
          .mockResolvedValue({ id: "ada", name: "Ada Learner" }),
      },
      // The guard's failure is the app's, whose Try again reloads everything.
      2,
    ],
  ])(
    "offers to try again when Braivo does not answer %s in time on Continue",
    async (_, stubs, brandReads) => {
      const hostOrganization = vi.fn(async () => ({ name: "Fernwood" }));
      renderAt("/c/4732", { signedIn: true, hostOrganization, ...stubs });
      fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
      const next = await screen.findByRole("button", { name: "Continue" });

      vi.useFakeTimers();
      fireEvent.click(next);
      await waitOut(READ_DEADLINE_MS);
      vi.useRealTimers();

      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(hostOrganization).toHaveBeenCalledTimes(brandReads);
    },
  );

  test.each([400, 403, 404, 409, 413])(
    "after a reload, forgets an answer refused with %i and loads the course as usual",
    async (status) => {
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => activity,
        submitAttempt: () => new Promise(() => {}),
      });
      fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
      cleanup();

      const { nextActivity, submitAttempt } = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
        submitAttempt: async () => {
          throw new BraivoError(status, "refused");
        },
      });
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(submitAttempt).toHaveBeenCalledTimes(1);
      expect(nextActivity).toHaveBeenCalledTimes(1);
      cleanup();

      const again = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
      });
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(again.submitAttempt).not.toHaveBeenCalled();
    },
  );

  test("does not resend an answer refused before the reload", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => {
        throw new BraivoError(400, "refused");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    cleanup();

    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("sends a learner whose session ended during a reload to sign in, keeping their answer for after", async () => {
    const before = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    let signedIn = true;
    const { router } = renderAt("/c/4732", {
      signedIn: true,
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      submitAttempt: async () => {
        signedIn = false;
        throw new BraivoError(401, "no session");
      },
    });
    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    cleanup();

    const after = renderAt("/c/4732", { signedIn: true });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    expect(after.submitAttempt.mock.calls[0]![0]).toEqual(before.submitAttempt.mock.calls[0]![0]);
  });

  test("shows a graded answer's feedback again after a reload, until the learner continues", async () => {
    const graded = {
      kind: "choice" as const,
      outcome: "failure" as const,
      correctChoice: 0,
      explanation: "Preterite.",
    };
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => graded,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    cleanup();

    const { nextActivity, submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => graded,
    });
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("Preterite.")).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(nextActivity).not.toHaveBeenCalled();
  });

  test("resends an unfinished answer on a visit, never on a preload", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    const { router, submitAttempt } = renderAt("/", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    await screen.findByRole("heading", { name: "Your courses" });
    await router.preloadRoute({ to: "/c/$courseRef", params: { courseRef: "4732" } });
    expect(submitAttempt).not.toHaveBeenCalled();

    await router.navigate({ to: "/c/$courseRef", params: { courseRef: "4732" } });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("shows the grade a reload finds after a 401 from a session that still holds", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new BraivoError(401, "no session"))
      .mockResolvedValueOnce({ kind: "choice", outcome: "success", correctChoice: 0 });
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test.each([
    ["no decision", { ...activity, decision: undefined }],
    ["an intent it does not know", { ...activity, decision: { intent: "drill" } }],
    ["an option it cannot read", { ...activity, task: { ...activity.task, options: [null] } }],
  ])("ignores an unfinished answer with %s, loading the course as usual", async (_, saved) => {
    sessionStorage.setItem(
      "braivo.unfinishedAttempt:ada:c1",
      JSON.stringify({ id: "a1", response: { choice: 0 }, activity: saved }),
    );
    const { nextActivity, submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
    expect(nextActivity).toHaveBeenCalledTimes(1);
  });

  test("keeps an unfinished answer whose resend was abandoned by leaving, whatever it came to", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    let refuse!: (error: unknown) => void;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce({ kind: "choice", outcome: "success", correctChoice: 0 });
    const { router } = renderAt("/c/4732", { signedIn: true, submitAttempt });
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(1));
    await router.navigate({ to: "/" });
    // Settling after the page was left, it decides nothing.
    refuse(new BraivoError(409, "resting"));

    await router.navigate({ to: "/c/$courseRef", params: { courseRef: "4732" } });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(2);
  });

  test("never resends one learner's answer as another's", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      user: { id: "grace", name: "Grace Learner" },
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("holds Continue while the next activity loads, so a second press does not restart it", async () => {
    let loaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockReturnValueOnce(new Promise((resolve) => (loaded = resolve)));
    renderAt("/c/4732", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(next);
    fireEvent.click(next);

    expect(next.textContent).toBe("Loading…");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.matches(":disabled")).toBe(false);
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));

    loaded(undefined);
    expect(await screen.findByText("You're caught up")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  test.each([400, 403, 413])(
    "gives up on an answer Braivo refuses with %i, rather than inviting another choice",
    async (status) => {
      renderAt("/c/4732", {
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
      getSession: async () => ({ data: null, error: null }),
    } as unknown as AppContext["auth"];
    const braivo = {
      hostOrganization: async () => undefined,
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      learnerCourseByNumber: async () => ({
        id: "c1",
        number: 4732,
        title: "Spanish",
        urlLabel: "spanish",
      }),
      learnerProgress: async () => noProgress,
      nextActivity: async () => activity,
      submitAttempt: async () => {
        signedIn = false;
        throw new BraivoError(401, "no session");
      },
    } as unknown as AppContext["braivo"];
    const router = createLearnRouter({
      history: createMemoryHistory({ initialEntries: ["/c/4732"] }),
      context: { auth, braivo, visit: () => {} },
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  test("says when a just-answered task comes back, and asks again then", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 0.05 })
      .mockResolvedValueOnce(activity);
    renderAt("/c/4732", { signedIn: true, nextActivity });

    const notice = await screen.findByRole("region", { name: "Take a short break" });
    expect(document.activeElement).toBe(notice);
    expect(notice.textContent).toContain("You practised Past tense recently.");

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  // From 10:00:00: never early, nor a minute late on the minute itself.
  test.each([
    [340, "10:06"],
    [300, "10:05"],
  ])("says when practice continues, %is on, as %s", async (retryAfter, shown) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-01T10:00:00.000Z"));
    onTestFinished(() => now.mockRestore());
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({ objective: activity.objective, retryAfter }),
    });

    const notice = await screen.findByRole("region", { name: "Take a short break" });
    const when = new Date(`2026-06-01T${shown}:00.000Z`).toLocaleTimeString("en", {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(notice.textContent).toContain(`Practice continues at ${when},`);
  });

  test("asks a returning task afresh, in the order it comes back in", async () => {
    const reshuffled: Activity = {
      ...activity,
      task: { ...activity.task, options: activity.task.options.toReversed() },
    };
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 0.05 })
        .mockResolvedValueOnce(reshuffled),
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Unanswered, though it is the same task: nothing carries over.
    await screen.findByRole("region", { name: "Take a short break" });
    const [first, second] = await screen.findAllByRole("button", { name: /^habl/ });
    expect(first).toBe(screen.getByRole("button", { name: "hablé" }));
    expect(second!.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(first!);

    const [before, after] = submitAttempt.mock.calls.map(([input]) => input!);
    expect(after).toMatchObject({ taskId: "t1", response: { choice: 0 } });
    expect(after!.id).not.toBe(before!.id);
  });

  test("rests a task answered moments ago elsewhere, rather than asking again", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 600 });
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => {
        throw new BraivoError(409, "resting");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Take a short break")).toBeTruthy();
  });
});
