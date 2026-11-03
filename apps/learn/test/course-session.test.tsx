// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient, type LearnerProgressSummary } from "@braivo/server/client";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { SESSION_LENGTH } from "../components/practice-session.tsx";
import { saveUnfinishedAttempt, unfinishedAttempt } from "../lib/unfinished-attempt.ts";
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

// Most tests here answer ten questions first: under a loaded suite, more than a test's default five seconds.
describe("the learn app", { timeout: 20_000 }, () => {
  test("ends a session after ten answers with what it saw, the question waiting, and where the learner stands", async () => {
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

    // What the page saw, not the course's change (Past tense retained since,
    // which evidence from elsewhere could have done); a question waits next.
    const end = await screen.findByRole("region", {
      name: "Session complete",
      description: "8 of 10 right. More to practise now.",
    });
    expect(document.activeElement).toBe(end);
    // Where the learner stands, as it is, after the actions however long its list runs.
    const standings = within(end).getByText("1 retained · 1 not started");
    expect(
      within(end).getByRole("link", { name: "Done" }).compareDocumentPosition(standings) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(sessionBar()).toBe(`${SESSION_LENGTH} of ${SESSION_LENGTH} answered`);
    // The end, not an eleventh question, though what comes next was read with it;
    // the last answer forgotten, as Continue past it would.
    expect(nextActivity).toHaveBeenCalledTimes(SESSION_LENGTH + 1);
    expect(screen.queryByText("Past tense of 'hablar'?")).toBeNull();
    expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
    expect(within(end).getByRole("link", { name: "Done" }).getAttribute("href")).toBe("/");

    fireEvent.click(within(end).getByRole("button", { name: "Keep going" }));
    // Ten rounds before it: under a loaded suite, more than the default second.
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 5000 })).toBeTruthy();
    expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`);
    // Read afresh: what the end read is no reservation.
    expect(nextActivity).toHaveBeenCalledTimes(SESSION_LENGTH + 2);
  });

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
      description: "10 of 10 right. More to practise now.",
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
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 5000 })).toBeTruthy();
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
    // What the page saw alone: no claim on the course's standing, which shows as it is.
    expect(within(caughtUp).queryByText(/newly|retained\./)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test.each([
    ["caught up", undefined, /^Nothing is due right now\. Next review due: Past tense, /, false],
    [
      "the day's limit",
      { dailyLimit: 20 },
      /^You can start new material again tomorrow\. Next review due: Past tense, /,
      false,
    ],
    // Its tasks resting after a miss: standing says learning, yet nothing to answer now.
    [
      "a rest",
      { objective: activity.objective, retryAfter: 600 },
      /^Practice continues at /,
      false,
    ],
    [
      "no task to practise with",
      { decision: activity.decision, objective: activity.objective },
      null,
      false,
    ],
  ] as const)(
    "ends a session that reaches %s with why practice stops, and Done alone",
    async (_, next, line, canKeepGoing) => {
      const nextActivity = vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValue(activity)
        .mockResolvedValueOnce(activity);
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity,
        learnerProgress: async () => standing("retaining"),
        submitAttempt,
      });
      await answer(SESSION_LENGTH);
      // What the selector offers after the tenth answer.
      nextActivity.mockResolvedValue(next as Awaited<ReturnType<BraivoClient["nextActivity"]>>);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      const end = await screen.findByRole("region", { name: "Session complete" });
      const said = end.querySelector('[data-slot="empty-description"]')!.textContent!;
      expect(said.startsWith("10 of 10 right.")).toBe(true);
      if (line) expect(said.slice("10 of 10 right.".length)).toMatch(line);
      else expect(said).toBe("10 of 10 right.");
      expect(within(end).queryByText("More to practise now.")).toBeNull();
      expect(within(end).queryByRole("button", { name: "Keep going" }) !== null).toBe(canKeepGoing);
      // Done the main action where Keep going is not.
      expect(within(end).getByRole("link", { name: "Done" }).dataset.variant).toBe("default");
    },
  );

  test("offers Keep going and claims nothing of what comes next when that cannot be read", async () => {
    const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });
    await answer(SESSION_LENGTH);
    nextActivity.mockRejectedValueOnce(new BraivoError(500, "unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const end = await screen.findByRole("region", {
      name: "Session complete",
      description: "10 of 10 right.",
    });
    // Never caught up for want of an answer: Keep going tries again.
    fireEvent.click(within(end).getByRole("button", { name: "Keep going" }));
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 5000 })).toBeTruthy();
  });

  test("reloads the course, not a session's end, when the course is gone by its tenth answer", async () => {
    const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });
    await answer(SESSION_LENGTH);
    nextActivity.mockRejectedValue(new BraivoError(404, "not found"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("region", {
        name: "This course does not exist, or is not one of yours.",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Session complete" })).toBeNull();
    // Gone, the course takes the answer with it, as on Continue.
    expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
  });

  test("counts an answer once when a reload's resend, then Send again, finds its grade again", async () => {
    const success = { kind: "choice", outcome: "success", correctChoice: 0 } as const;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(success)
      // The reload's resend of the same attempt, lost.
      .mockRejectedValueOnce(new BraivoError(500, "unavailable"))
      .mockResolvedValue(success);
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      // Continue's read, signed out for the moment: the course reloads in place.
      .mockRejectedValueOnce(new BraivoError(401, "session could not be used"))
      .mockResolvedValue(activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await screen.findByRole("button", { name: "Continue" });

    // One attempt, sent three times: one answer, one right.
    expect(new Set(submitAttempt.mock.calls.map(([input]) => input.id)).size).toBe(1);
    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);
  });

  test("counts an answer first confirmed by Send again, once", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ kind: "choice", outcome: "success", correctChoice: 0 });
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await screen.findByRole("button", { name: "Continue" });

    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);
  });

  test("never counts an answer from a visit before, even once a recovery finds its grade again", async () => {
    saveUnfinishedAttempt("ada", "c1", { id: "before", activity, response: { choice: 0 } });
    const success = { kind: "choice", outcome: "success", correctChoice: 0 } as const;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      // The visit's resend finds its grade: not this session's answer.
      .mockResolvedValueOnce(success)
      // An in-place recovery resends it again, lost; Send again finds it.
      .mockRejectedValueOnce(new BraivoError(500, "unavailable"))
      .mockResolvedValue(success);
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockRejectedValueOnce(new BraivoError(401, "session could not be used"))
      .mockResolvedValue(activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`);
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await screen.findByRole("button", { name: "Continue" });

    expect(new Set(submitAttempt.mock.calls.map(([input]) => input.id))).toEqual(
      new Set(["before"]),
    );
    expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`);
  });
});
