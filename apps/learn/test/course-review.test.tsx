// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Reviewing an objective's passages after a miss or during a rest
// (learner-loop-24, -26, ADR 0054).

import {
  type Activity,
  BraivoError,
  type BraivoClient,
  type Grade,
  type ObjectiveReview,
} from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { SESSION_LENGTH } from "../components/practice-session.tsx";
import { unfinishedAttempt } from "../lib/unfinished-attempt.ts";
import { activity, anotherActivity } from "./fixtures.ts";
import { renderAt, stall } from "./render.tsx";

const miss: Grade = { kind: "choice", outcome: "failure", correctChoice: 0, reviewable: true };
const success: Grade = { ...miss, outcome: "success" };
const review: ObjectiveReview = {
  title: "Past tense",
  passages: [
    { quote: "Ayer hablé con ella.", page: "12", source: { title: "Unidad 4" } },
    {
      quote: "Hablé, hablaste, habló.",
      at: 62,
      source: { title: "Video", url: "https://www.youtube.com/watch?v=abc123" },
    },
  ],
};
const resting = (retryAfter: number, reviewable = true): Activity => ({
  objective: activity.objective,
  retryAfter,
  reviewable,
});

/** The course with `activity` missed as "hablo", graded as `grade`. */
async function missed(
  options: {
    grade?: Grade;
    objectiveReview?: BraivoClient["objectiveReview"];
    nextActivity?: BraivoClient["nextActivity"];
    submitAttempt?: BraivoClient["submitAttempt"];
    session?: BraivoClient["session"];
    user?: { id: string; name: string };
  } = {},
) {
  const rendered = renderAt("/c/4732", {
    signedIn: true,
    session: options.session,
    user: options.user,
    nextActivity: options.nextActivity ?? (async () => activity),
    submitAttempt: options.submitAttempt ?? (async () => options.grade ?? miss),
    objectiveReview: options.objectiveReview ?? (async () => review),
  });
  fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
  await screen.findByRole("button", { name: "Continue" });
  return rendered;
}

/** Opens the review and waits for its passages. */
async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Review this topic" }));
  return await screen.findByRole("region", { name: "Review: Past tense" });
}

function back() {
  fireEvent.click(screen.getByRole("button", { name: "Back to practice" }));
}

describe("reviewing an objective after a miss", () => {
  test("is offered with the teaching, above the foot, and nowhere before an answer", async () => {
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity });
    await screen.findByRole("button", { name: "hablo" });
    expect(screen.queryByRole("button", { name: "Review this topic" })).toBeNull();
    cleanup();

    await missed();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    const reviewButton = screen.getByRole("button", { name: "Review this topic" });
    const report = screen.getByRole("button", { name: "Report a problem" });
    expect(document.activeElement).toBe(continueButton);
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // In the page, not the foot, which stays short: the focus starts past it, on Continue.
    expect(follows(reviewButton, screen.getByRole("alert"))).toBe(true);
    expect(follows(reviewButton, continueButton)).toBe(true);
    expect(follows(continueButton, report)).toBe(true);
  });

  test.each([
    ["a success", { grade: success }],
    ["an objective with nothing to review", { grade: { ...miss, reviewable: false } }],
  ])("is not offered after %s", async (_case, options) => {
    await missed(options);
    expect(screen.queryByRole("button", { name: "Review this topic" })).toBeNull();
  });

  test("is offered after Show answer", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => miss,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));
    expect(await screen.findByRole("button", { name: "Review this topic" })).toBeTruthy();
  });

  test("shows the objective's passages with where each is from, focused, recording nothing", async () => {
    const { objectiveReview, submitAttempt } = await missed();

    fireEvent.click(screen.getByRole("button", { name: "Review this topic" }));
    const heading = screen.getByRole("heading", { name: "Review: Past tense" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    // The question and its feedback give way to it.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    const region = await screen.findByRole("region", { name: "Review: Past tense" });
    expect(within(region).getByRole("heading", { name: "From your lessons" })).toBeTruthy();
    expect(within(region).getByText("Ayer hablé con ella.")).toBeTruthy();
    expect(within(region).getByText("Unidad 4 · p. 12")).toBeTruthy();
    expect(within(region).getByRole("link", { name: "Video · 1:02" }).getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=abc123&t=62s",
    );
    expect(objectiveReview).toHaveBeenCalledWith(
      { courseId: "c1", objectiveId: "o1" },
      expect.anything(),
    );
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("returns to the same feedback, focus on Review this topic, and Report a problem still opens", async () => {
    await missed();
    await openReview();
    back();

    expect(screen.queryByRole("region", { name: "Review: Past tense" })).toBeNull();
    expect(screen.getByText("Not quite")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review this topic" }));
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog", { name: "What's wrong with this question?" })).toBeTruthy();
  });

  test.each([
    ["a failed read", async () => Promise.reject(new BraivoError(500, "down"))],
    ["nothing to show", async () => undefined],
  ] satisfies [string, BraivoClient["objectiveReview"]][])(
    "says so after %s, marks nothing, and goes back",
    async (_case, objectiveReview) => {
      const nextActivity = vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValue(anotherActivity);
      const { submitAttempt } = await missed({ objectiveReview, nextActivity });

      fireEvent.click(screen.getByRole("button", { name: "Review this topic" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("This couldn't be loaded.");
      back();

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "comí" }));
      await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(2));
      expect(submitAttempt.mock.calls[1]![0]).not.toHaveProperty("reviewedTeaching");
    },
  );

  test("signed out since, sends the learner to sign in, as a failed answer does", async () => {
    let signedIn = true;
    const { router } = await missed({
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      objectiveReview: async () => {
        signedIn = false;
        throw new BraivoError(401, "signed out");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Review this topic" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  test("cannot be opened while Continue reads the next question", async () => {
    await missed({
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockImplementation((_, options) => stall(options)),
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const reviewButton = screen.getByRole("button", { name: "Review this topic" });
    expect(reviewButton.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(reviewButton);
    expect(screen.queryByRole("heading", { name: "Review: Past tense" })).toBeNull();
  });
});

describe("the next attempt after a review", () => {
  test("never counts toward the session: only answers do", async () => {
    const sessionBar = () =>
      screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuetext");
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    await missed({ nextActivity });
    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);

    await openReview();
    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);
    back();
    expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await screen.findByRole("button", { name: "Continue" });
    expect(sessionBar()).toBe(`2 of ${SESSION_LENGTH} answered`);
  });

  test("says it once, then never again, and a second miss offers the review again", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    const { submitAttempt } = await missed({ nextActivity });
    await openReview();
    back();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await screen.findByRole("button", { name: "Continue" });
    expect(submitAttempt.mock.calls[1]![0]).toMatchObject({
      taskId: "t2",
      reviewedTeaching: true,
    });
    // Missed again: offered again, and nothing loops.
    expect(screen.getByRole("button", { name: "Review this topic" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(3));
    expect(submitAttempt.mock.calls[2]![0]).not.toHaveProperty("reviewedTeaching");
  });

  test("keeps it with the unfinished answer, so a reload resends it unchanged", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(miss)
      // Lost: kept for a reload.
      .mockImplementation((_, options) => stall(options));
    await missed({ nextActivity, submitAttempt });
    await openReview();
    back();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(2));
    expect(unfinishedAttempt("ada", "c1")).toMatchObject({ reviewedTeaching: true });
    cleanup();

    const { submitAttempt: resent } = renderAt("/c/4732", {
      signedIn: true,
      submitAttempt: async () => miss,
    });
    await screen.findByRole("button", { name: "Continue" });
    expect(resent.mock.calls[0]![0]).toMatchObject({ taskId: "t2", reviewedTeaching: true });
  });

  test("sends it again with Send again, as the same attempt", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(miss)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(miss);
    await missed({ nextActivity, submitAttempt });
    await openReview();
    back();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await screen.findByRole("button", { name: "Continue" });

    expect(submitAttempt.mock.calls[2]![0]).toEqual(submitAttempt.mock.calls[1]![0]);
    expect(submitAttempt.mock.calls[2]![0]).toMatchObject({ reviewedTeaching: true });
  });

  test("keeps a resumed answer's Send again as it was sent, whatever was reviewed since", async () => {
    // Sent without a review, then reloaded before Continue: its feedback shows.
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: (_, options) => stall(options),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    cleanup();
    renderAt("/c/4732", {
      signedIn: true,
      submitAttempt: async () => miss,
      objectiveReview: async () => review,
    });
    await screen.findByRole("button", { name: "Continue" });
    await openReview();
    cleanup();

    // Reloaded again, its resend lost this time: Send again sends it unchanged.
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(miss);
    renderAt("/c/4732", { signedIn: true, submitAttempt });
    fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
    await screen.findByRole("button", { name: "Continue" });
    expect(submitAttempt.mock.calls[1]![0]).toEqual(submitAttempt.mock.calls[0]![0]);
    expect(submitAttempt.mock.calls[1]![0]).not.toHaveProperty("reviewedTeaching");
  });

  test("marks it again when that attempt is refused for good", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(miss)
      // Retired while on screen: recorded nothing, and the course reloads.
      .mockRejectedValueOnce(new BraivoError(404, "retired"))
      .mockResolvedValue(miss);
    await missed({ nextActivity, submitAttempt });
    await openReview();
    back();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(3));
    expect(submitAttempt.mock.calls[2]![0]).toMatchObject({ reviewedTeaching: true });
  });

  test("is never sent as another learner's on the same tab", async () => {
    await missed();
    await openReview();
    cleanup();

    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      user: { id: "bea", name: "Bea Learner" },
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => miss,
    });
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    await screen.findByRole("button", { name: "Continue" });
    expect(submitAttempt.mock.calls[0]![0]).not.toHaveProperty("reviewedTeaching");
  });

  test("never changes the answer already sent, whose feedback a reload shows", async () => {
    // A reload resends an answer sent without a review, and shows its feedback.
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: (_, options) => stall(options),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    cleanup();
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      submitAttempt: async () => miss,
      objectiveReview: async () => review,
    });
    await screen.findByRole("button", { name: "Continue" });
    await openReview();
    back();
    cleanup();

    const { submitAttempt: again } = renderAt("/c/4732", {
      signedIn: true,
      submitAttempt: async () => miss,
    });
    await screen.findByRole("button", { name: "Continue" });
    expect(submitAttempt.mock.calls[0]![0]).not.toHaveProperty("reviewedTeaching");
    expect(again.mock.calls[0]![0]).toEqual(submitAttempt.mock.calls[0]![0]);
  });
});

describe("reviewing an objective while it rests", () => {
  test("is offered when it can be, and never releases the rest", async () => {
    const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => resting(600));
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity,
      objectiveReview: async () => review,
    });
    await screen.findByRole("region", { name: "Take a short break" });
    await openReview();
    back();

    const notice = screen.getByRole("region", { name: "Take a short break" });
    expect(document.activeElement).toBe(
      within(notice).getByRole("button", { name: "Review this topic" }),
    );
    expect(nextActivity).toHaveBeenCalledTimes(1);
  });

  test("is not offered for an objective with nothing to review", async () => {
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => resting(600, false) });
    await screen.findByRole("region", { name: "Take a short break" });
    expect(screen.queryByRole("button", { name: "Review this topic" })).toBeNull();
  });

  test("holds the rest's end while reviewing, and goes on to the next question on Back", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(resting(0.05))
      .mockResolvedValue(activity);
    renderAt("/c/4732", { signedIn: true, nextActivity, objectiveReview: async () => review });
    await screen.findByRole("region", { name: "Take a short break" });
    await openReview();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(nextActivity).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Review: Past tense" })).toBeTruthy();

    back();
    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });
});
