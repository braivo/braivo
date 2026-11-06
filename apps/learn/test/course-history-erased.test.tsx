// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type BraivoClient } from "@braivo/server/client";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { SESSION_LENGTH } from "../components/practice-session.tsx";
import { unfinishedAttempt } from "../lib/unfinished-attempt.ts";
import { activity, anotherActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

// The learner's history at this school erased while they practise
// (learner-loop-25): an answer begun before it is gone for good, the page says
// so, and practice starts fresh.

const ERASED =
  "Your learning history here was cleared, so your last answer wasn't saved. You're starting fresh.";
const refused = () => new BraivoError(409, "erased", undefined, "HISTORY_ERASED");
const graded: Awaited<ReturnType<BraivoClient["submitAttempt"]>> = {
  kind: "choice",
  outcome: "success",
  correctChoice: 0,
};
const afterwards = { ...anotherActivity, historyEpoch: 1 };
const sessionBar = () =>
  screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuetext");

describe("the learn app, a history erased", () => {
  test("sends the epoch its activity was read under", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({ ...activity, historyEpoch: 3 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(1));
    expect(submitAttempt.mock.calls[0]![0]).toMatchObject({ historyEpoch: 3 });
  });

  test("an answer refused says so, is forgotten, and the session starts afresh on what comes next", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(afterwards);
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(graded)
      .mockRejectedValueOnce(refused())
      .mockResolvedValue(graded);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Continue" })).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(await screen.findByText(ERASED)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
    // Never the generic refusal's page, and nothing it counted of the old history.
    expect(screen.queryByText("This answer couldn't be recorded.")).toBeNull();
    await vi.waitFor(() => expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`));

    // The next answer goes under the new epoch; the notice has been said.
    fireEvent.click(screen.getByRole("button", { name: "comí" }));
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(3));
    expect(submitAttempt.mock.calls[2]![0]).toMatchObject({ historyEpoch: 1 });
    await vi.waitFor(() => expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`));
    // Beside an answer that was saved, it would seem to speak of that one.
    expect(screen.queryByText(ERASED)).toBeNull();
  });

  test("an answer refused drops the old session's count even when no question follows", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(activity)
      .mockResolvedValue({ objective: activity.objective, retryAfter: 340 });
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockResolvedValueOnce(graded)
      .mockRejectedValueOnce(refused());
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Continue" })).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    await screen.findByRole("region", { name: "Take a short break" });
    expect(await screen.findByText(ERASED)).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: "Session" })).toBeNull(),
    );
  });

  test("fresh practice after a refusal keeps counting when what comes next is no question", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(afterwards)
      .mockResolvedValue({ objective: activity.objective, retryAfter: 340 });
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(refused())
      .mockResolvedValue(graded);
    renderAt("/c/4732", { signedIn: true, nextActivity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "comí" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("region", { name: "Take a short break" });
    // The refusal was said and reset once, not again as the epoch left the screen.
    await vi.waitFor(() => expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`));
  });

  test("a delayed resend of a stored answer is refused, cleared, and said once", async () => {
    const before = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    const sent = before.submitAttempt.mock.calls[0]![0]!;
    cleanup();
    expect(unfinishedAttempt("ada", "c1")?.activity.historyEpoch).toBe(0);

    const later = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => afterwards,
      submitAttempt: async () => {
        throw refused();
      },
    });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(await screen.findByText(ERASED)).toBeTruthy();
    // The answer as it was begun, its epoch included.
    expect(later.submitAttempt.mock.calls[0]![0]).toEqual(sent);
    expect(unfinishedAttempt("ada", "c1")).toBeUndefined();
    cleanup();

    const reloaded = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => afterwards,
    });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText(ERASED)).toBeNull();
    expect(reloaded.submitAttempt).not.toHaveBeenCalled();
  });

  test("a stored answer from before epochs is not resent: nothing could say which it was", async () => {
    const { historyEpoch: _, ...unversioned } = activity;
    sessionStorage.setItem(
      "braivo.unfinishedAttempt:ada:c1",
      JSON.stringify({ id: "a1", response: { choice: 0 }, activity: unversioned }),
    );
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("a new epoch found by Continue starts the session afresh, as another tab's erasure leaves it", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(afterwards);
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => graded,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(sessionBar()).toBe(`1 of ${SESSION_LENGTH} answered`));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    await vi.waitFor(() => expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`));
    // No answer of theirs was refused: nothing to say.
    expect(screen.queryByText(ERASED)).toBeNull();
  });

  test(
    "a new epoch found past the tenth answer shows what comes next, never the erased session's recap",
    { timeout: 20_000 },
    async () => {
      const nextActivity = vi.fn<BraivoClient["nextActivity"]>(async () => activity);
      renderAt("/c/4732", {
        signedIn: true,
        nextActivity,
        submitAttempt: async () => graded,
      });
      for (let each = 1; each <= SESSION_LENGTH; each++) {
        fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
        const next = await screen.findByRole("button", { name: "Continue" });
        await vi.waitFor(() => expect(sessionBar()).toBe(`${each} of ${SESSION_LENGTH} answered`));
        if (each === SESSION_LENGTH) nextActivity.mockResolvedValue(afterwards);
        fireEvent.click(next);
        if (each < SESSION_LENGTH) {
          await vi.waitFor(() =>
            expect(screen.queryByRole("button", { name: "Continue" })).toBeNull(),
          );
        }
      }
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(screen.queryByText("Session complete")).toBeNull();
      await vi.waitFor(() => expect(sessionBar()).toBe(`0 of ${SESSION_LENGTH} answered`));
    },
  );

  test("a bare 409 stays what it was: no notice, and the session kept", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValue(anotherActivity);
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => {
        throw new BraivoError(409, "resting");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText(ERASED)).toBeNull();
  });
});
