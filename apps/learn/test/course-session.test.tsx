// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient, type LearnerProgressSummary } from "@braivo/server/client";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { SESSION_LENGTH } from "../components/session-end.tsx";
import { unfinishedAttempt } from "../lib/unfinished-attempt.ts";
import { SPANISH_ID, activity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** Past tense in the phase given, Greetings not started. */
function standing(pastTense: "unseen" | "retaining"): LearnerProgressSummary {
  return {
    modelVersion: "v1",
    asOf: "2026-06-01T00:00:00.000Z",
    repeatedMissesThreshold: 3,
    lastPractisedAt: null,
    objectives: [
      pastTense === "unseen"
        ? { objectiveId: "o1", title: "Past tense", phase: "unseen" }
        : {
            objectiveId: "o1",
            title: "Past tense",
            phase: "retaining",
            lastEvidenceAt: "2026-06-01T00:00:00.000Z",
            stability: 1,
            retrievability: 1,
            due: false,
            dueAt: "2026-06-02T00:00:00.000Z",
          },
      { objectiveId: "o2", title: "Greetings", phase: "unseen" },
    ],
  };
}

function sessionBar() {
  return screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuetext");
}

/**
 * Answers `count` questions, the ones in `wrong` (1-based) with the wrong
 * option, pressing Continue after each, the last one's left to the caller.
 */
async function answer(count: number, wrong: number[] = []) {
  for (let each = 1; each <= count; each++) {
    const option = wrong.includes(each) ? "hablo" : "hablé";
    fireEvent.click(await screen.findByRole("button", { name: option }));
    const next = await screen.findByRole("button", { name: "Continue" });
    await vi.waitFor(() => expect(sessionBar()).toBe(`${each} of ${SESSION_LENGTH} answered`));
    if (each === count) return;
    fireEvent.click(next);
    // The answered question stays until the next replaces it: wait, or its option is pressed.
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }
}

/** Grades "hablé" right, anything else wrong, as the fixture's task does. */
const submitAttempt: BraivoClient["submitAttempt"] = async ({ response }) => ({
  kind: "choice",
  outcome: "choice" in response && response.choice === 0 ? "success" : "failure",
  correctChoice: 0,
});

describe("the learn app", () => {
  test(
    "ends a session after ten answers with its score, what it retained, and where the learner stands",
    { timeout: 20_000 },
    async () => {
      const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => activity);
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity,
        learnerProgress: vi
          .fn<BraivoClient["learnerProgress"]>()
          .mockResolvedValueOnce(standing("unseen"))
          .mockResolvedValue(standing("retaining")),
        submitAttempt,
      });
      expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
      expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`);

      await answer(SESSION_LENGTH, [3, 7]);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      const end = await screen.findByRole("region", {
        name: "Session complete",
        description: /^8 of 10 right\. 1 newly retained\. Next review due: Past tense, /,
      });
      expect(document.activeElement).toBe(end);
      // Which one, in the standing's list, after the next step however long it runs.
      const standings = within(end).getByText("1 retained · 1 not started");
      fireEvent.click(standings);
      expect(within(end).getByText("Past tense: newly retained")).toBeTruthy();
      expect(
        within(end).getByRole("link", { name: "Done" }).compareDocumentPosition(standings) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(sessionBar()).toBe(`${SESSION_LENGTH} of ${SESSION_LENGTH} answered`);
      // The end, not an eleventh question; the last answer forgotten, as Continue past it would.
      expect(nextActivity).toHaveBeenCalledTimes(SESSION_LENGTH);
      expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
      expect(within(end).getByRole("link", { name: "Done" }).getAttribute("href")).toBe("/");

      fireEvent.click(within(end).getByRole("button", { name: "Keep going" }));
      // Ten rounds before it: under a loaded suite, more than the default second.
      expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 5000 })).toBeTruthy();
      expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`);
      expect(nextActivity).toHaveBeenCalledTimes(SESSION_LENGTH + 1);
    },
  );

  test("says the score alone when where the learner stands cannot be read at the end", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => {
        throw new BraivoError(500, "unavailable");
      },
      submitAttempt,
    });

    await answer(SESSION_LENGTH);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const end = await screen.findByRole("region", {
      name: "Session complete",
      description: "10 of 10 right.",
    });
    expect(within(end).queryByText(/not started/)).toBeNull();
  });

  test("keeps the end when Keep going fails, saying so each time, until it goes on", async () => {
    const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });
    await answer(SESSION_LENGTH);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const end = await screen.findByRole("region", { name: "Session complete" });

    nextActivity.mockRejectedValueOnce(new BraivoError(500, "unavailable"));
    const keepGoing = within(end).getByRole("button", { name: "Keep going" });
    fireEvent.click(keepGoing);
    expect(await within(end).findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not load the next question. Try again.",
    );
    expect(screen.getByRole("region", { name: "Session complete" })).toBeTruthy();

    fireEvent.click(keepGoing);
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
  });

  test("rechecks the account before a session's end, reloading as another signed in meanwhile", async () => {
    let user = { id: "ada", name: "Ada Learner" };
    renderAt("/c/4732", {
      signedIn: true,
      session: async () => user,
      nextActivity: async () => activity,
      submitAttempt,
    });
    await answer(SESSION_LENGTH);

    user = { id: "bea", name: "Bea Learner" };
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Bea's own practice, from none answered: not Ada's end, nor her count.
    await vi.waitFor(() => expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`));
    expect(screen.queryByRole("region", { name: "Session complete" })).toBeNull();
    // Ada's last answer kept for her, as Continue keeps it.
    expect(unfinishedAttempt("ada", "c1")).toBeDefined();
  });

  test("starts another course's practice from none answered", async () => {
    const { router } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt,
    });
    await answer(3);

    await act(() => router.navigate({ to: "/c/$courseRef", params: { courseRef: SPANISH_ID } }));

    await vi.waitFor(() => expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`));
  });

  test("recaps a session cut short by being caught up, and keeps its bar through a rest", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 600 })
      .mockResolvedValue(undefined);
    const { router } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity,
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce(standing("unseen"))
        .mockResolvedValue(standing("retaining")),
      submitAttempt,
    });
    await answer(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Resting: the session goes on, its bar as it was.
    expect(await screen.findByRole("region", { name: "Take a short break" })).toBeTruthy();
    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);

    // The rest's end finds nothing more: practice stops, saying what this session did.
    await act(() => router.invalidate());
    const caughtUp = await screen.findByRole("region", { name: "You're caught up" });
    expect(within(caughtUp).getByText("1 of 1 right.")).toBeTruthy();
    expect(within(caughtUp).getByText("1 newly retained.")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test("names as newly retained only what was not started or learning as the session began, and when to come back", async () => {
    const due = standing("retaining");
    const objectives = due.objectives.map((each) =>
      each.phase === "retaining" ? { ...each, due: true } : each,
    );
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      // Past tense due for review as the session starts, retained again by its end.
      learnerProgress: vi
        .fn<BraivoClient["learnerProgress"]>()
        .mockResolvedValueOnce({ ...due, objectives })
        .mockResolvedValue(standing("retaining")),
      submitAttempt,
    });
    await answer(SESSION_LENGTH);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const end = await screen.findByRole("region", { name: "Session complete" });
    expect(within(end).queryByText(/newly retained/)).toBeNull();
    expect(within(end).getByText(/^Next review due: Past tense, /)).toBeTruthy();
  });

  test("says there is more to practise now, not when the next review falls due, while an objective is due", async () => {
    const retained = standing("retaining");
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => ({
        ...retained,
        objectives: [
          // Past tense retained, its review tomorrow; Greetings due now.
          retained.objectives[0]!,
          {
            objectiveId: "o2",
            title: "Greetings",
            phase: "retaining",
            lastEvidenceAt: "2026-06-01T00:00:00.000Z",
            stability: 1,
            retrievability: 0.5,
            due: true,
            dueAt: "2026-06-01T12:00:00.000Z",
          },
        ],
      }),
      submitAttempt,
    });
    await answer(SESSION_LENGTH);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const end = await screen.findByRole("region", { name: "Session complete" });
    expect(within(end).getByText("More to practise now.")).toBeTruthy();
    expect(within(end).queryByText(/^Next review due/)).toBeNull();
  });
});
