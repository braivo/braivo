// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type BraivoClient } from "@braivo/server/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import type { AppContext } from "../lib/context.ts";
import {
  ANSWER_DEADLINE_MS,
  OPTIONAL_READ_DEADLINE_MS,
  READ_DEADLINE_MS,
} from "../lib/deadline.ts";
import { unfinishedAttempt } from "../lib/unfinished-attempt.ts";
import { createLearnRouter } from "../router.tsx";
import { SPANISH_ID, typedActivity, activity, anotherActivity, noProgress } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

/** The grade's title, apart from the option marked Correct. */
const GRADE_TITLE = '[data-slot="alert-title"]';

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
        reviewable: false,
        explanation: "Preterite.",
      }),
    });

    // The task answered, not the next one, graded as before the reload.
    expect(await screen.findByText("Not quite")).toBeTruthy();
    // Body text by the question, read as Continue takes the focus.
    expect(
      screen.getByRole("button", { name: "Continue", description: "Preterite." }),
    ).toBeTruthy();
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
      .mockResolvedValueOnce({
        kind: "choice",
        outcome: "success",
        correctChoice: 0,
        reviewable: false,
      });
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
        reviewable: false,
      }));
      renderAt("/c/4732", { signedIn: true, submitAttempt });

      expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
      // The same attempt, ID and all, so Braivo records it once.
      expect(lost.mock.calls[0]![0]!.response).toEqual(response);
      expect(submitAttempt.mock.calls[0]![0]).toEqual(lost.mock.calls[0]![0]);
      // A typed miss marks the answer's missed letter in a copy apart (course.test.tsx).
      expect(screen.getByRole("alert").textContent).toBe(
        `${title}The answer: bin${"text" in response ? "bin" : ""}`,
      );
    },
  );

  test("offers to send an answer again when Braivo does not answer in time", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockImplementationOnce((_input, options) => stall(options))
      .mockResolvedValueOnce({
        kind: "choice",
        outcome: "success",
        correctChoice: 0,
        reviewable: false,
      });
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
    // By number: a course named by ID waits on what the host serves (`lib/host.ts`).
    ["the brand", "/c/4732", { hostOrganization: (options) => stall(options) }],
    ["the summary", `/c/${SPANISH_ID}`, { learnerProgress: (_input, options) => stall(options) }],
    // By ID, as the title is read from the list then.
    ["the title", `/c/${SPANISH_ID}`, { learnerCourses: (options) => stall(options) }],
  ] satisfies [string, string, Partial<Parameters<typeof renderAt>[1]>][])(
    "asks the question without %s when Braivo does not answer it in time",
    async (_, path, stubs) => {
      vi.useFakeTimers();
      renderAt(path, {
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
    ],
  ])(
    "keeps the answered question when Braivo does not answer %s in time on Continue, which tries again",
    async (_, stubs) => {
      const hostOrganization = vi.fn(async () => ({ name: "Fernwood" }));
      renderAt("/c/4732", { signedIn: true, hostOrganization, ...stubs });
      fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
      const next = await screen.findByRole("button", { name: "Continue" });

      vi.useFakeTimers();
      fireEvent.click(next);
      await waitOut(READ_DEADLINE_MS);
      vi.useRealTimers();

      expect(await screen.findByText("Could not load the next question. Try again.")).toBeTruthy();
      expect(screen.getByText("Past tense of 'hablar'?")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Close" })).toBeTruthy();
      fireEvent.click(next);
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      // Continue reads what comes next, never the brand again.
      expect(hostOrganization).toHaveBeenCalledOnce();
    },
  );

  /** An answer left on its way, so the next visit resends it. */
  async function leaveAnswerUnfinished() {
    const before = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();
    return before.submitAttempt.mock.calls[0]![0]!;
  }

  const LAST_REFUSED = "Your last answer couldn't be recorded.";

  test.each([400, 403, 413])(
    "after a reload, says an answer refused with %i couldn't be recorded, above the next question, once",
    async (status) => {
      const sent = await leaveAnswerUnfinished();

      const submitAttempt = vi
        .fn<BraivoClient["submitAttempt"]>()
        .mockRejectedValueOnce(new BraivoError(status, "refused"))
        .mockResolvedValue({
          kind: "choice",
          outcome: "success",
          correctChoice: 1,
          reviewable: false,
        });
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
        submitAttempt,
      });
      const question = await screen.findByRole("button", { name: "comí" });
      const line = await screen.findByText(LAST_REFUSED);
      expect(line.getAttribute("role")).toBe("status");
      expect(
        line.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
      expect(unfinishedAttempt("ada", "c1")).toBeUndefined();

      // The next question is a new attempt, never the refused one again.
      fireEvent.click(question);
      expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
      expect(submitAttempt).toHaveBeenCalledTimes(2);
      expect(submitAttempt.mock.calls[1]![0].id).not.toBe(sent.id);
      // Said of the refused answer alone: beside this one, it would seem to mean it.
      expect(screen.queryByText(LAST_REFUSED)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      cleanup();

      const again = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
      });
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(screen.queryByText(LAST_REFUSED)).toBeNull();
      expect(again.submitAttempt).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "a rest",
      { objective: activity.objective, retryAfter: 600, reviewable: false },
      "Take a short break",
    ],
    ["caught up", undefined, "You're caught up"],
  ] as const)(
    "after a reload, says an answer was refused above %s too",
    async (_case, next, title) => {
      await leaveAnswerUnfinished();
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => next,
        submitAttempt: async () => {
          throw new BraivoError(400, "refused");
        },
      });
      const notice = await screen.findByRole("region", { name: title });
      const line = await screen.findByText(LAST_REFUSED);
      expect(line.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  test("says an answer refused on a reload couldn't be recorded once the course loads after failing", async () => {
    await leaveAnswerUnfinished();
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(anotherActivity),
      submitAttempt: async () => {
        throw new BraivoError(413, "too large");
      },
    });
    const failed = await screen.findByRole("region", { name: "Something went wrong." });
    expect(screen.queryByText(LAST_REFUSED)).toBeNull();

    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(await screen.findByText(LAST_REFUSED)).toBeTruthy();
    cleanup();

    renderAt("/c/4732", { signedIn: true, nextActivity: async () => anotherActivity });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText(LAST_REFUSED)).toBeNull();
  });

  test("says an answer refused on a reload couldn't be recorded when storage was full until it was forgotten", async () => {
    await leaveAnswerUnfinished();
    // Full while the refused answer is kept: room for the notice once it goes.
    const kept = "braivo.unfinishedAttempt:ada:c1";
    const items = new Map([[kept, sessionStorage.getItem(kept)!]]);
    sessionStorage.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem(key: string, value: string) {
        if (items.has(kept)) throw new DOMException("Full", "QuotaExceededError");
        items.set(key, value);
      },
      removeItem: (key: string) => items.delete(key),
      clear: () => items.clear(),
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => {
        throw new BraivoError(400, "refused");
      },
    });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(await screen.findByText(LAST_REFUSED)).toBeTruthy();
  });

  test.each([404, 409])(
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
      expect(screen.queryByText(LAST_REFUSED)).toBeNull();
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
    expect(
      await screen.findByRole("region", { name: "This answer couldn't be recorded." }),
    ).toBeTruthy();
    cleanup();

    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
    // Said on the page already: not again.
    expect(screen.queryByText(LAST_REFUSED)).toBeNull();
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
      reviewable: false,
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
    // Body text by the question, read as Continue takes the focus.
    expect(
      screen.getByRole("button", { name: "Continue", description: "Preterite." }),
    ).toBeTruthy();
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
      .mockResolvedValueOnce({
        kind: "choice",
        outcome: "success",
        correctChoice: 0,
        reviewable: false,
      });
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test.each([
    ["no epoch", { ...activity, historyEpoch: undefined }],
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
      .mockResolvedValueOnce({
        kind: "choice",
        outcome: "success",
        correctChoice: 0,
        reviewable: false,
      });
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

  // An account erased and made again, with the same name and address, has a new ID.
  const recreated = { id: "ada-again", name: "Ada Fernley" };

  test("never resends by itself an answer from before the account was erased", async () => {
    const before = renderAt("/c/4732", {
      signedIn: true,
      user: { id: "ada", name: "Ada Fernley" },
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();

    // Erased: the reload finds no session, and keeps the answer for its learner.
    renderAt("/c/4732", { signedIn: false });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    cleanup();

    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      user: recreated,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
    expect(unfinishedAttempt(recreated.id, SPANISH_ID)).toBeUndefined();

    // A fresh answer is theirs: a new attempt, carrying nothing of the old one.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(1));
    const sent = submitAttempt.mock.calls[0]![0]!;
    const old = before.submitAttempt.mock.calls[0]![0]!;
    expect(sent.id).not.toBe(old.id);
    expect(sent.response).not.toEqual(old.response);
  });

  test("Send again sends nothing as an account made since, which gets the question fresh", async () => {
    let signedIn = { id: "ada", name: "Ada Fernley" };
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderAt("/c/4732", {
      signedIn: true,
      session: async () => signedIn,
      nextActivity: async () => activity,
      submitAttempt,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const again = await screen.findByRole("button", { name: "Send again" });
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    // Erased, and signed in again elsewhere: the cookie is the new account's.
    signedIn = recreated;
    fireEvent.click(again);

    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Send again" })).toBeNull());
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(screen.queryByText("Your answer could not be confirmed.")).toBeNull();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("Send again sends nothing while it cannot tell who is signed in, and can be pressed again", async () => {
    const session = vi
      .fn<BraivoClient["session"]>()
      .mockResolvedValue({ id: "ada", name: "Ada Fernley" });
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        kind: "choice",
        outcome: "success",
        correctChoice: 0,
        reviewable: false,
      });
    renderAt("/c/4732", {
      signedIn: true,
      session,
      nextActivity: async () => activity,
      submitAttempt,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const again = await screen.findByRole("button", { name: "Send again" });

    session.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(again);
    await vi.waitFor(() => expect(again.getAttribute("aria-disabled")).toBe("false"));
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    fireEvent.click(again);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(2);
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

  test("keeps the answered question when the next one does not load in time, saying so each time, until it does", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockImplementationOnce((_id, options) => stall(options))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(anotherActivity);
    const { submitAttempt } = renderAt("/c/4732", { signedIn: true, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });

    vi.useFakeTimers();
    fireEvent.click(next);
    await waitOut(READ_DEADLINE_MS);
    vi.useRealTimers();

    const failed = "Could not load the next question. Try again.";
    // An alert of its own, announced as it mounts.
    const first = (await screen.findByText(failed)).closest('[role="alert"]');
    expect(first?.textContent).toBe(failed);
    // The lesson stays: the question, its feedback, and Continue, still focused, to retry.
    expect(screen.getByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.getByText("Correct", { selector: GRADE_TITLE })).toBeTruthy();
    expect(next.isConnected).toBe(true);
    expect(document.activeElement).toBe(next);
    expect(next.textContent).toBe("Continue");

    fireEvent.click(next);
    // A new alert, so a screen reader announces the second failure too.
    await vi.waitFor(() => expect(first?.isConnected).toBe(false));
    expect(screen.getByText(failed).closest('[role="alert"]')).toBeTruthy();

    fireEvent.click(next);
    expect(await screen.findByText("Past tense of 'comer'?")).toBeTruthy();
    expect(screen.queryByText(failed)).toBeNull();
    expect(nextActivity).toHaveBeenCalledTimes(4);
    // Answered once: Continue never resends.
    expect(submitAttempt).toHaveBeenCalledOnce();
  });

  test("keeps the answered question when the session cannot be checked on Continue, and shows its grade again after a reload", async () => {
    let stalled = false;
    const session = vi.fn<BraivoClient["session"]>(async (options) =>
      stalled ? stall(options) : { id: "ada", name: "Ada Learner" },
    );
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      session,
      nextActivity: async () => activity,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });

    stalled = true;
    vi.useFakeTimers();
    fireEvent.click(next);
    await waitOut(READ_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByText("Could not load the next question. Try again.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Close" })).toBeTruthy();
    expect(screen.getByText("Correct", { selector: GRADE_TITLE })).toBeTruthy();

    // Not continued past, so a reload resends it and shows its grade again.
    cleanup();
    stalled = false;
    const reloaded = renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity });
    expect(await screen.findByText("Correct", { selector: GRADE_TITLE })).toBeTruthy();
    expect(reloaded.submitAttempt.mock.calls[0]![0]).toEqual(submitAttempt.mock.calls[0]![0]);
  });

  test("on Continue, says why the course is gone, or sends a learner signed out to sign in, rather than offering to retry", async () => {
    const gone = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockRejectedValue(new BraivoError(404, "not found"));
    renderAt("/c/4732", { signedIn: true, nextActivity: gone });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("This course does not exist, or is not one of yours."),
    ).toBeTruthy();
    cleanup();

    let signedIn = true;
    const { router } = renderAt("/c/4732", {
      signedIn: true,
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockImplementation(async () => {
          signedIn = false;
          throw new BraivoError(401, "no session");
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  test("holds Continue while a 404 on it reloads the course, so the old question cannot be continued again", async () => {
    let reloaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockRejectedValueOnce(new BraivoError(404, "not found"))
      .mockReturnValueOnce(new Promise((resolve) => (reloaded = resolve)));
    renderAt("/c/4732", { signedIn: true, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(next);
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(3));
    await act(async () => {});

    expect(next.textContent).toBe("Loading…");
    await act(async () => reloaded(anotherActivity));
    expect(await screen.findByText("Past tense of 'comer'?")).toBeTruthy();
  });

  test("on Continue, reads what comes next while rechecking the session, showing it only once the session is the learner's", async () => {
    const checked = Promise.withResolvers<{ id: string; name: string }>();
    const session = vi
      .fn<BraivoClient["session"]>()
      .mockResolvedValueOnce({ id: "ada", name: "Ada Learner" })
      .mockReturnValueOnce(checked.promise);
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    renderAt("/c/4732", { signedIn: true, session, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // One round trip, not two: the read starts while the session check is out.
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));
    expect(session).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(screen.queryByText("Past tense of 'comer'?")).toBeNull();

    await act(async () => checked.resolve({ id: "ada", name: "Ada Learner" }));
    expect(await screen.findByText("Past tense of 'comer'?")).toBeTruthy();
  });

  test("on Continue, shows the next question without reading where the learner stands, which a question never shows", async () => {
    const learnerProgress = vi
      .fn<BraivoClient["learnerProgress"]>()
      .mockResolvedValueOnce(noProgress)
      .mockImplementation((_input, options) => stall(options));
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    renderAt("/c/4732", { signedIn: true, learnerProgress, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Well inside the standing's own deadline: nothing waits on it.
    expect(
      await screen.findByText("Past tense of 'comer'?", undefined, { timeout: 500 }),
    ).toBeTruthy();
    // Never read for a question: the page's load read it once, and nothing since.
    expect(learnerProgress).toHaveBeenCalledOnce();
  });

  test("on Continue, lets a refusal read as another account signed in meanwhile clear nothing of the first one's", async () => {
    let user = { id: "ada", name: "Ada Learner" };
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      // As Bea, the course is not hers.
      .mockRejectedValueOnce(new BraivoError(404, "not found"))
      .mockResolvedValue(anotherActivity);
    renderAt("/c/4732", { signedIn: true, session: async () => user, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });

    user = { id: "bea", name: "Bea Learner" };
    fireEvent.click(next);

    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(3));
    // Ada's answer, kept for her: the 404 was Bea's.
    expect(unfinishedAttempt("ada", "c1")).toBeDefined();
  });

  test("on Continue, reloads the course as another account signed in meanwhile, keeping the first one's answer for them", async () => {
    let user = { id: "ada", name: "Ada Learner" };
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    const session = vi.fn(async () => user);
    renderAt("/c/4732", { signedIn: true, session, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });

    user = { id: "bea", name: "Bea Learner" };
    fireEvent.click(next);

    expect(await screen.findByText("Past tense of 'comer'?")).toBeTruthy();
    // Continued as Ada, her answer would be forgotten: reloaded, it is kept for her.
    expect(unfinishedAttempt("ada", "c1")).toBeDefined();
    // The guard's, Continue's, and the reload's guard's, as Bea.
    expect(session).toHaveBeenCalledTimes(3);
  });

  test("ignores a Continue still loading once the course reloaded, leaving the answer kept", async () => {
    let answer!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { router } = renderAt("/c/4732", { signedIn: true, nextActivity });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));

    // A reload meanwhile resends the kept answer and shows its grade.
    await act(() => router.invalidate({ sync: true }));
    const again = await screen.findByRole("button", { name: "Continue" });
    expect(again.textContent).toBe("Continue");
    await act(async () => answer(anotherActivity));

    expect(screen.getByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByText("Past tense of 'comer'?")).toBeNull();
    expect(unfinishedAttempt("ada", "c1")).toBeDefined();
  });

  test("ignores a session check answered after the learner left the course on Continue", async () => {
    let answer!: (user: { id: string; name: string }) => void;
    const session = vi
      .fn<BraivoClient["session"]>()
      .mockResolvedValueOnce({ id: "ada", name: "Ada Learner" })
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({ id: "ada", name: "Ada Learner" });
    const { router } = renderAt("/c/4732", {
      signedIn: true,
      session,
      nextActivity: async () => activity,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("link", { name: "Close" }));
    await screen.findByText(/no courses/i);
    expect(session.mock.calls[1]?.[0]?.signal?.aborted).toBe(true);
    const calls = session.mock.calls.length;
    // Another account by then: acted on, it would reload the list as that account.
    await act(async () => answer({ id: "bea", name: "Bea Learner" }));

    expect(session).toHaveBeenCalledTimes(calls);
    expect(router.state.location.pathname).toBe("/");
  });

  test("ignores a Continue refused once a reload showed the same answer again, keeping it", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();
    let refuse!: (error: unknown) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockReturnValueOnce(new Promise((_resolve, reject) => (refuse = reject)));
    const { router } = renderAt("/c/4732", { signedIn: true, nextActivity });
    // Resent on the visit, graded.
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledOnce());

    await act(() => router.invalidate({ sync: true }));
    await act(async () => refuse(new BraivoError(404, "not found")));

    expect(screen.getByText("Correct", { selector: GRADE_TITLE })).toBeTruthy();
    expect(unfinishedAttempt("ada", "c1")).toBeDefined();
  });

  test.each([400, 403, 413])(
    "offers a way forward from an answer Braivo refuses with %i: Continue reloads the page, or Your courses",
    async (status) => {
      // Stubbed: happy-dom would load the document anew.
      const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
      onTestFinished(() => reload.mockRestore());
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => activity,
        submitAttempt: async () => {
          throw new BraivoError(status, "refused");
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

      const notice = await screen.findByRole("region", {
        name: "This answer couldn't be recorded.",
        description: "Continue practising.",
      });
      expect(document.activeElement).toBe(notice);
      // White-label: the organization's brand, never the product's.
      expect(notice.textContent).not.toMatch(/Braivo/);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
      // Forgotten, as it would be refused again.
      expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
      expect(within(notice).getByRole("link", { name: "Your courses" }).getAttribute("href")).toBe(
        "/",
      );

      // A whole document load, so a page built before an update loads the current app.
      const proceed = within(notice).getByRole("button", { name: "Continue" });
      fireEvent.click(proceed);
      expect(reload).toHaveBeenCalledOnce();
      expect(proceed.textContent).toBe("Loading…");
      expect(proceed.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(proceed);
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  test("sends a learner whose session ended to sign in, rather than asking them to retry", async () => {
    let signedIn = true;
    const auth = {
      getSession: async () => ({ data: null, error: null }),
    } as unknown as AppContext["auth"];
    const braivo = {
      host: async () => ({ organization: null, installation: false }),
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
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 0.05, reviewable: false })
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
      nextActivity: async () => ({ objective: activity.objective, retryAfter, reviewable: false }),
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
        .mockResolvedValueOnce({
          objective: activity.objective,
          retryAfter: 0.05,
          reviewable: false,
        })
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
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 600, reviewable: false });
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
