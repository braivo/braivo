// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BraivoError,
  type BraivoClient,
  type Grade,
  type LearnerProgressStanding,
  type LearnerProgressSummary,
} from "@braivo/server/client";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { OPTIONAL_READ_DEADLINE_MS } from "../lib/deadline.ts";
import { SPANISH_ID, activity, anotherActivity, noProgress } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

describe("the learn app", () => {
  test("shows the learner where they stand in the course, read as themselves", async () => {
    const at = "2026-06-01T00:00:00.000Z";
    const { learnerProgress } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          {
            objectiveId: "a",
            title: "Greetings",
            phase: "retaining",
            lastEvidenceAt: at,
            stability: 3,
            retrievability: 0.95,
            due: false,
            dueAt: "2026-06-04T00:00:00.001Z",
          },
          {
            objectiveId: "b",
            title: "Numbers",
            phase: "retaining",
            lastEvidenceAt: at,
            stability: 1,
            retrievability: 0.5,
            due: true,
            dueAt: "2026-06-02T00:00:00.001Z",
          },
          {
            objectiveId: "c",
            title: "Colours",
            phase: "acquiring",
            lastEvidenceAt: at,
          },
          { objectiveId: "d", title: "Days", phase: "unseen" },
          { objectiveId: "e", title: "Months", phase: "unseen" },
        ],
      }),
    });

    const summary = await screen.findByText(
      "1 retained · 1 due for review · 1 learning · 2 not started",
    );
    // Which is which opens from the counts, by name.
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(
      within(details)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Greetings: retained",
      "Numbers: due for review",
      "Colours: learning",
      "Days: not started",
      "Months: not started",
    ]);
    // Without the history, which the summary never shows.
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "c1", learnerId: "ada", includeHistory: false },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("leaves out empty counts", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          { objectiveId: "a", title: "Greetings", phase: "unseen" },
          { objectiveId: "b", title: "Numbers", phase: "unseen" },
        ],
      }),
    });

    expect(await screen.findByText("2 not started")).toBeTruthy();
  });

  test("says how practice goes until an objective starts", async () => {
    const hint =
      "One question at a time. What you get wrong comes back soon; what you get right returns for review before you're likely to forget it.";
    const pastTense: LearnerProgressStanding = {
      objectiveId: "o1",
      title: "Past tense",
      phase: "unseen",
    };
    const greetings: LearnerProgressStanding = {
      ...pastTense,
      objectiveId: "o2",
      title: "Greetings",
    };
    let reported: LearnerProgressStanding[] = [pastTense, greetings];
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: reported,
      }),
      submitAttempt: async () => ({ kind: "choice", outcome: "failure", correctChoice: 0 }),
    });

    // Read with the question, which takes the focus.
    expect(
      await screen.findByRole("group", {
        name: "Past tense of 'hablar'?",
        description: `New · Past tense ${hint}`,
      }),
    ).toBeTruthy();

    // A wrong answer starts the objective; once Continue reloads progress, the line goes.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    reported = [
      {
        ...pastTense,
        phase: "acquiring",
        lastEvidenceAt: "2026-06-01T00:00:00.000Z",
      },
      greetings,
    ];
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText(hint)).toBeNull();
    cleanup();

    // No objectives reported: nothing to say.
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => noProgress,
    });
    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByText(hint)).toBeNull();
  });

  test("still asks the question when where they stand cannot be read", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => {
        throw new BraivoError(500, "unavailable");
      },
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByText(/^One question at a time/)).toBeNull();
  });

  /** Past tense in the phase given, Greetings not started. */
  function progressSummary(
    pastTense: "unseen" | "acquiring" | "retaining",
  ): LearnerProgressSummary {
    const at = "2026-06-01T00:00:00.000Z";
    return {
      modelVersion: "v1",
      asOf: "2026-06-01T00:00:00.000Z",
      repeatedMissesThreshold: 3,
      lastPractisedAt: null,
      objectives: [
        pastTense === "unseen"
          ? { objectiveId: "o1", title: "Past tense", phase: "unseen" }
          : pastTense === "acquiring"
            ? { objectiveId: "o1", title: "Past tense", phase: "acquiring", lastEvidenceAt: at }
            : {
                objectiveId: "o1",
                title: "Past tense",
                phase: "retaining",
                lastEvidenceAt: at,
                stability: 1,
                retrievability: 1,
                due: false,
                dueAt: "2026-06-02T00:00:00.000Z",
              },
        { objectiveId: "o2", title: "Greetings", phase: "unseen" },
      ],
    };
  }

  test.each([
    ["a wrong answer", "hablo", "failure", "acquiring", "1 learning · 1 not started"],
    ["Show answer", "Show answer", "failure", "acquiring", "1 learning · 1 not started"],
    ["a right answer", "hablé", "success", "retaining", "1 retained · 1 not started"],
  ] as const)(
    "counts %s where the learner stands before Continue, Continue keeping the focus",
    async (_, press, outcome, phase, counted) => {
      let reported = progressSummary("unseen");
      const { learnerProgress } = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => activity,
        learnerProgress: async () => reported,
        submitAttempt: async () => {
          reported = progressSummary(phase);
          return { kind: "choice", outcome, correctChoice: 0 };
        },
      });
      expect(await screen.findByText("2 not started")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: press }));

      expect(await screen.findByText(counted)).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
      expect(learnerProgress).toHaveBeenCalledTimes(2);
      expect(learnerProgress).toHaveBeenLastCalledWith(
        { courseId: "c1", learnerId: "ada", includeHistory: false },
        { signal: expect.any(AbortSignal) },
      );
    },
  );

  test("hides the earlier counts while reading them again, and leaves them out past the deadline", async () => {
    vi.useFakeTimers();
    const grading = Promise.withResolvers<Grade>();
    const { learnerProgress } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockImplementation((_input, options) => stall(options)),
      submitAttempt: () => grading.promise,
    });
    await waitOut(0);
    const before = screen.getByText("2 not started").closest("details")!;
    expect(before.getAttribute("aria-hidden")).toBeNull();

    // Not on the answer: on its grade.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    await waitOut(0);
    expect(before.getAttribute("aria-hidden")).toBeNull();
    expect(learnerProgress).toHaveBeenCalledTimes(1);
    grading.resolve({ kind: "choice", outcome: "failure", correctChoice: 0 });
    await waitOut(0);

    // Kept in place, so the page does not jump, but neither seen nor read.
    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(before.getAttribute("aria-hidden")).toBe("true");
    expect(before.className).toContain("invisible");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));

    await waitOut(OPTIONAL_READ_DEADLINE_MS);
    expect(screen.queryByText("2 not started")).toBeNull();
    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
  });

  test("leaves the counts out, not the earlier ones back, when reading them again fails", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockRejectedValue(new BraivoError(500, "unavailable")),
      submitAttempt: async () => ({ kind: "choice", outcome: "failure", correctChoice: 0 }),
    });
    expect(await screen.findByText("2 not started")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "hablo" }));

    expect(await screen.findByText("Not quite")).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByText("2 not started")).toBeNull());
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  test.each(["Continue", "a reload resending the same answer"])(
    "drops a read of the counts that answers after %s, showing the reload's",
    async (how) => {
      const late = Promise.withResolvers<LearnerProgressSummary>();
      const learnerProgress = vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockReturnValueOnce(late.promise)
        .mockResolvedValue(progressSummary("retaining"));
      const { router, submitAttempt } = renderAt("/c/4732", {
        signedIn: true,
        nextActivity: async () => activity,
        learnerProgress,
        submitAttempt: async () => ({ kind: "choice", outcome: "failure", correctChoice: 0 }),
      });
      expect(await screen.findByText("2 not started")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "hablo" }));
      expect(await screen.findByText("Not quite")).toBeTruthy();

      if (how === "Continue") fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      else await act(() => router.invalidate());
      expect(await screen.findByText("1 retained · 1 not started")).toBeTruthy();

      await act(async () => late.resolve(progressSummary("acquiring")));
      expect(screen.getByText("1 retained · 1 not started")).toBeTruthy();
      expect(screen.queryByText("1 learning · 1 not started")).toBeNull();
      // The reload's own read, and no other.
      expect(learnerProgress).toHaveBeenCalledTimes(3);
      // The reload resent the same attempt, never a second one.
      if (how !== "Continue") {
        expect(submitAttempt).toHaveBeenCalledTimes(2);
        expect(submitAttempt.mock.calls[1]![0]).toEqual(submitAttempt.mock.calls[0]![0]);
      }
    },
  );

  test("ignores an answer graded after the learner left for another course", async () => {
    const abandoned = Promise.withResolvers<Grade>();
    const { learnerProgress, router } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockResolvedValue(progressSummary("acquiring")),
      // The first answer's grade arrives although leaving aborted its request.
      submitAttempt: vi
        .fn<BraivoClient["submitAttempt"]>()
        .mockReturnValueOnce(abandoned.promise)
        .mockResolvedValue({ kind: "choice", outcome: "failure", correctChoice: 0 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));

    await act(() => router.navigate({ to: "/c/$courseRef", params: { courseRef: SPANISH_ID } }));
    expect(await screen.findByText("2 not started")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    expect(await screen.findByText("1 learning · 1 not started")).toBeTruthy();

    await act(async () =>
      abandoned.resolve({ kind: "choice", outcome: "success", correctChoice: 0 }),
    );
    expect(screen.getByText("1 learning · 1 not started")).toBeTruthy();
    expect(learnerProgress).toHaveBeenCalledTimes(3);
  });

  test("shows the counts again once a reload reads them, after reading them again failed", async () => {
    const { learnerProgress, router } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(progressSummary("unseen"))
        .mockRejectedValueOnce(new BraivoError(500, "unavailable"))
        .mockResolvedValue(progressSummary("acquiring")),
      submitAttempt: async () => ({ kind: "choice", outcome: "failure", correctChoice: 0 }),
    });
    expect(await screen.findByText("2 not started")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    await vi.waitFor(() => expect(screen.queryByText("2 not started")).toBeNull());

    await act(() => router.invalidate());

    expect(await screen.findByText("1 learning · 1 not started")).toBeTruthy();
    expect(learnerProgress).toHaveBeenCalledTimes(3);
  });

  test("tells a learner with nothing due that they are caught up", async () => {
    renderAt("/c/4732", { signedIn: true });

    const notice = await screen.findByRole("region", {
      name: "You're caught up",
      description: "Nothing is due right now.",
    });
    expect(document.activeElement).toBe(notice);
  });

  test("tells a learner held back by the day's limit on new material to come back tomorrow, not that they are caught up", async () => {
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => ({ dailyLimit: 20 }) });

    expect(
      await screen.findByRole("region", {
        name: "That's all the new material for today",
        description: "You can start new material again tomorrow. Nothing is due right now.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  const retained = (objectiveId: string, title: string, dueAt: string, due = false) => ({
    objectiveId,
    title,
    phase: "retaining" as const,
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
    stability: 1,
    retrievability: due ? 0.5 : 0.95,
    due,
    dueAt,
  });

  /** Now in Warsaw, whose clocks change on 29 March and 25 October 2026. */
  const inWarsawAt = (now: string) => {
    vi.stubEnv("TZ", "Europe/Warsaw");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
  };

  test("tells a caught-up learner when their next review falls due, and of what", async () => {
    // 09:44 on Friday 5 June in Warsaw.
    inWarsawAt("2026-06-05T07:44:00.000Z");
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          retained("a", "Greetings", "2026-06-09T00:00:00.000Z"),
          // Shown rounded up, never early.
          retained("b", "Numbers", "2026-06-05T09:30:00.001Z"),
          // Due by the report, read a moment after the activity: its time has passed.
          retained("c", "Colours", "2026-06-02T00:00:00.000Z", true),
        ],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "You're caught up",
        description: "Nothing is due right now. Next review due: Numbers, today at 11:31 AM.",
      }),
    ).toBeTruthy();
  });

  test.each([
    // 23:00, and a review at 01:00: tomorrow by the clock, though before the learner day's 04:00.
    ["2026-06-05T21:00:00.000Z", "2026-06-05T23:00:00.000Z", "tomorrow at 1:00 AM"],
    // Rounded up past midnight.
    ["2026-06-05T12:00:00.000Z", "2026-06-05T21:59:00.001Z", "tomorrow at 12:00 AM"],
    // The night before a 23-hour day: 24 hours on is already the day after.
    ["2026-03-28T22:30:00.000Z", "2026-03-29T10:00:00.000Z", "tomorrow at 12:00 PM"],
    // The day after tomorrow, in full.
    ["2026-06-05T07:44:00.000Z", "2026-06-07T10:00:00.000Z", "on Sunday, June 7, 2026 at 12:00 PM"],
  ])("at %s, names a review due at %s as %s", async (now, dueAt, when) => {
    inWarsawAt(now);
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({ dailyLimit: 20 }),
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [retained("a", "Greetings", dueAt)],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "That's all the new material for today",
        description: `You can start new material again tomorrow. Next review due: Greetings, ${when}.`,
      }),
    ).toBeTruthy();
  });

  test("tells a learner where practice stops what they practised today, by their local day", async () => {
    // Auckland, UTC+12 in June: its 11 June begins at 04:00, 10 June, 16:00 UTC.
    vi.stubEnv("TZ", "Pacific/Auckland");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-11T02:00:00.000Z"));
    const standing = (objectiveId: string, at: string, phase: "acquiring" | "retaining") =>
      phase === "acquiring"
        ? { objectiveId, title: objectiveId, phase, lastEvidenceAt: at }
        : {
            objectiveId,
            title: objectiveId,
            phase,
            lastEvidenceAt: at,
            stability: 1,
            retrievability: 0.95,
            due: false,
            dueAt: "2026-06-12T02:00:00.000Z",
          };
    const progress: LearnerProgressSummary = {
      modelVersion: "v1",
      asOf: "2026-06-01T00:00:00.000Z",
      repeatedMissesThreshold: 3,
      lastPractisedAt: null,
      objectives: [
        standing("a", "2026-06-11T01:00:00.000Z", "retaining"),
        // Today locally, though 10 June in UTC.
        standing("b", "2026-06-10T17:00:00.000Z", "retaining"),
        standing("c", "2026-06-10T16:00:00.000Z", "acquiring"),
        // Due again already: due for review, as the summary says (beside "Nothing is due" only in a race).
        {
          objectiveId: "f",
          title: "f",
          phase: "retaining",
          lastEvidenceAt: "2026-06-11T00:00:00.000Z",
          stability: 0.04,
          retrievability: 0.5,
          due: true,
          dueAt: "2026-06-11T01:00:00.000Z",
        },
        // Before 04:00 locally, still 10 June's, or never: not today's.
        standing("d", "2026-06-10T15:59:59.999Z", "retaining"),
        { objectiveId: "e", title: "e", phase: "unseen" },
      ],
    };
    renderAt("/c/4732", { signedIn: true, learnerProgress: async () => progress });

    expect(
      await screen.findByRole("region", {
        name: "You're caught up",
        description:
          /^Nothing is due right now\..* Practised today: 2 retained · 1 due for review · 1 learning\.$/,
      }),
    ).toBeTruthy();
    cleanup();

    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => progress,
      nextActivity: async () => ({ dailyLimit: 20 }),
    });
    expect(
      await screen.findByRole("region", {
        name: "That's all the new material for today",
        description: /Practised today: 2 retained · 1 due for review · 1 learning\.$/,
      }),
    ).toBeTruthy();
  });

  test("counts practice past midnight as the evening's, until four", async () => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    // 00:30 on 11 June in Auckland; the evidence, 23:00 on 10 June.
    vi.setSystemTime(new Date("2026-06-10T12:30:00.000Z"));
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          {
            objectiveId: "a",
            title: "a",
            phase: "acquiring",
            lastEvidenceAt: "2026-06-10T11:00:00.000Z",
          },
        ],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "You're caught up",
        description: "Nothing is due right now. Practised today: 1 learning.",
      }),
    ).toBeTruthy();
  });

  test("says nothing of today's practice when there was none today", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        asOf: "2026-06-01T00:00:00.000Z",
        repeatedMissesThreshold: 3,
        lastPractisedAt: null,
        objectives: [
          {
            objectiveId: "a",
            title: "a",
            phase: "acquiring",
            lastEvidenceAt: yesterday.toISOString(),
          },
        ],
      }),
    });

    expect(
      await screen.findByRole("region", {
        name: "You're caught up",
        description: "Nothing is due right now.",
      }),
    ).toBeTruthy();
  });
});
