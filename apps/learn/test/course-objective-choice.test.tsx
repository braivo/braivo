// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A learner chooses an objective to practise where practice pauses, and returns
// to the recommended one (learner-loop-28, ADR 0058).

import {
  type Activity,
  BraivoError,
  type BraivoClient,
  type LearnerProgressSummary,
} from "@braivo/server/client";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";

import { renderAt, stall } from "./render.tsx";

const at = "2026-06-01T00:00:00.000Z";

/** Greetings and Numbers retained, not due: a learner caught up. */
const caughtUp: LearnerProgressSummary = {
  modelVersion: "v1",
  asOf: at,
  historyEpoch: 0,
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
      stability: 3,
      retrievability: 0.95,
      due: false,
      dueAt: "2026-06-04T00:00:00.001Z",
    },
  ],
};

function activity(intent: "practise" | "reteach", id = "t1"): Activity {
  return {
    decision:
      intent === "practise"
        ? { objectiveId: "a", modelVersion: "v1", intent }
        : { objectiveId: "a", modelVersion: "v1", intent, lastEvidenceAt: at },
    objective: { id: "a", title: "Greetings" },
    historyEpoch: 0,
    task: {
      id,
      kind: "choice",
      prompt: `Hello, in Spanish? (${id})`,
      options: [
        { choice: 0, text: "Hola" },
        { choice: 1, text: "Adiós" },
      ],
    },
  };
}

/** Caught up unless an objective is chosen; then `chosen`'s answer for it. */
function whenChosen(chosen: (objectiveId: string) => Promise<Activity | undefined>) {
  return (async (_courseId, options) =>
    options?.objectiveId === undefined
      ? undefined
      : chosen(options.objectiveId)) satisfies BraivoClient["nextActivity"];
}

async function practiseGreetings() {
  fireEvent.click(await screen.findByRole("button", { name: "Choose a topic to practise" }));
  fireEvent.click(screen.getByRole("link", { name: "Practise Greetings" }));
}

describe("the learn app", () => {
  test("practises an objective chosen where practice pauses, one extra question, then returns to the recommended", async () => {
    const { nextActivity, router } = renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => activity("practise")),
    });
    expect(await screen.findByText("You're caught up")).toBeTruthy();

    // Said, not hidden in the counts: it opens them, each objective offering it by name.
    fireEvent.click(screen.getByRole("button", { name: "Choose a topic to practise" }));
    const list = screen.getByRole("list");
    const practise = within(list).getAllByRole("link");
    expect(practise.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Practise Greetings",
      "Practise Numbers",
    ]);
    expect(list.closest("details")!.open).toBe(true);
    expect(document.activeElement).toBe(practise[0]);
    expect(screen.queryByRole("button", { name: "Choose a topic to practise" })).toBeNull();
    fireEvent.click(practise[0]!);

    // The learner's request, never the model's: said so, with the way back
    // beside it, and no session's count, as it is no part of one.
    expect(await screen.findByText("Hello, in Spanish? (t1)")).toBeTruthy();
    expect(screen.getByText("Extra practice · Greetings")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Back to recommended" })).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(router.state.location.search).toEqual({ objective: "a" });
    expect(nextActivity).toHaveBeenLastCalledWith("c1", {
      signal: expect.any(AbortSignal),
      objectiveId: "a",
    });

    // Answered, it is finished: no Continue, the way back first.
    fireEvent.click(screen.getByRole("button", { name: /Hola/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Correct"));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Practise again" })).toBeTruthy();
    const back = screen.getAllByRole("link", { name: "Back to recommended" });
    expect(back).toHaveLength(1);
    expect(document.activeElement).toBe(back[0]);

    fireEvent.click(back[0]!);
    expect(await screen.findByText("You're caught up")).toBeTruthy();
    expect(router.state.location.search).toEqual({});
    expect(nextActivity).toHaveBeenLastCalledWith("c1", { signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("link", { name: "Back to recommended" })).toBeNull();
    // Not counted: the caught-up screen recaps no session.
    expect(screen.queryByText("1 of 1 right.")).toBeNull();
  });

  test("asks an extra question again only when the learner taps Practise again", async () => {
    const activities = [activity("practise", "t1"), activity("practise", "t2")];
    const { nextActivity } = renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => activities.shift()),
    });

    // A reload, or a link, keeps the choice.
    fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Practise again" }));

    expect(await screen.findByText("Hello, in Spanish? (t2)")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
    expect(nextActivity).toHaveBeenLastCalledWith("c1", {
      signal: expect.any(AbortSignal),
      objectiveId: "a",
    });
  });

  test("never turns practice on a chosen objective into extra practice by itself", async () => {
    const activities = [activity("reteach", "t1"), activity("practise", "t2")];
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => activities.shift()),
    });

    // Being learned: practice as usual, Continue and all.
    expect(await screen.findByText("Try again · Greetings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hola/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Now not due: said, the extra question waiting for the learner to ask.
    expect(await screen.findByText("Nothing is due on Greetings right now")).toBeTruthy();
    expect(screen.queryByText("Hello, in Spanish? (t2)")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Back to recommended" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Extra practice" }));
    expect(await screen.findByText("Hello, in Spanish? (t2)")).toBeTruthy();
    expect(screen.getByText("Extra practice · Greetings")).toBeTruthy();
  });

  test("asks no extra question by itself when a rest Continue reached ends", async () => {
    const activities: Activity[] = [
      activity("reteach", "t1"),
      { objective: { id: "a", title: "Greetings" }, retryAfter: 1, reviewable: false },
      activity("practise", "t2"),
    ];
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => activities.shift()),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Take a short break")).toBeTruthy();

    // Its one task rested; once it may be asked again, it is not, by itself.
    expect(
      await screen.findByText("Nothing is due on Greetings right now", {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText("Hello, in Spanish? (t2)")).toBeNull();
  });

  test("says when a chosen objective's practice resumes", async () => {
    renderPage(async () => ({
      objective: { id: "a", title: "Greetings" },
      retryAfter: 300,
      reviewable: false,
    }));
    expect(await screen.findByText("Take a short break")).toBeTruthy();
    expect(screen.getByText("Practising Greetings")).toBeTruthy();
  });

  test("shows the day's limit on a chosen objective not started yet", async () => {
    renderPage(async () => ({ dailyLimit: 20 }));
    expect(await screen.findByText("That's all the new material for today")).toBeTruthy();
    // Named from where the learner stands, as the limit names no objective.
    expect(screen.getByText("Practising Greetings")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to recommended" })).toBeTruthy();
  });

  test("goes back to the recommended for an objective no longer in the course", async () => {
    const { router } = renderAt("/c/4732?objective=gone", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: async (_courseId, options) => {
        if (options?.objectiveId !== undefined) {
          throw new BraivoError(404, "not found");
        }
        return undefined;
      },
    });

    expect(await screen.findByText("You're caught up")).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  // Ten answers first: under a loaded suite, more than a test's default five seconds.
  test(
    "starts a session afresh when Practise is chosen at a session's end",
    { timeout: 30_000 },
    async () => {
      // Unchosen, ten questions in a row; chosen, Greetings' extra question.
      renderAt("/c/4732", {
        signedIn: true,
        learnerProgress: async () => caughtUp,
        nextActivity: async (_courseId, options) =>
          options?.objectiveId === undefined ? activity("reteach", "r") : activity("practise", "x"),
      });
      for (let answered = 1; answered <= 10; answered++) {
        fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
        // The answered question stays until the next replaces it: wait, or its option is pressed.
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      }
      expect(await screen.findByText("Session complete")).toBeTruthy();

      await practiseGreetings();
      expect(await screen.findByText("Hello, in Spanish? (x)")).toBeTruthy();
      expect(screen.queryByText("Session complete")).toBeNull();

      // Back, a new session, from none answered.
      fireEvent.click(screen.getByRole("link", { name: "Back to recommended" }));
      expect(await screen.findByText("Hello, in Spanish? (r)")).toBeTruthy();
      expect(
        screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuenow"),
      ).toBe("0");
    },
  );

  // Ten answers first: under a loaded suite, more than a test's default five seconds.
  test(
    "starts afresh when the browser's history returns to a chosen objective after a session's end",
    { timeout: 30_000 },
    async () => {
      const { router } = renderAt("/c/4732?objective=a", {
        signedIn: true,
        learnerProgress: async () => caughtUp,
        nextActivity: async (_courseId, options) =>
          options?.objectiveId === undefined ? activity("reteach", "r") : activity("practise", "x"),
      });
      expect(await screen.findByText("Hello, in Spanish? (x)")).toBeTruthy();
      fireEvent.click(screen.getByRole("link", { name: "Back to recommended" }));
      expect(await screen.findByText("Hello, in Spanish? (r)")).toBeTruthy();
      for (let answered = 1; answered <= 10; answered++) {
        fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
        // The answered question stays until the next replaces it: wait, or its option is pressed.
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      }
      expect(await screen.findByText("Session complete")).toBeTruthy();

      // Not through Practise or Back to recommended: the browser's own Back.
      router.history.back();
      expect(await screen.findByText("Hello, in Spanish? (x)")).toBeTruthy();
      expect(screen.queryByText("Session complete")).toBeNull();
      expect(router.state.location.search).toEqual({ objective: "a" });
    },
  );

  test("drops that an extra question is not due once it is missed", async () => {
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => activity("practise")),
      submitAttempt: async () => ({
        kind: "choice",
        outcome: "failure",
        correctChoice: 0,
        reviewable: false,
      }),
    });
    expect(await screen.findByText("You chose this. It isn't due for review yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Adiós/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/^Not quite/));
    // The miss made it acquiring: "not due" no longer holds. Its label stays.
    expect(screen.queryByText("You chose this. It isn't due for review yet.")).toBeNull();
    expect(screen.getByText("Extra practice · Greetings")).toBeTruthy();
  });

  test("shows Practise as a control, not muted text, and says it is loading until its page shows", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: async (_courseId, options) =>
        options?.objectiveId === undefined ? undefined : stall(options),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Choose a topic to practise" }));
    const practise = screen.getByRole("link", { name: "Practise Greetings" });
    // Muted is the list's text, never its controls'.
    expect(practise.closest(".text-muted-foreground")).toBeNull();

    fireEvent.click(practise);
    await waitFor(() => expect(practise.textContent).toBe("Loading…"));
    expect(practise.getAttribute("aria-disabled")).toBe("true");
    // The other objective's stays as it was.
    expect(screen.getByRole("link", { name: "Practise Numbers" }).textContent).toBe("Practise");
  });

  test("says Practise again is loading until the next question shows", async () => {
    let reads = 0;
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => (++reads === 1 ? activity("practise") : stall())),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
    const again = await screen.findByRole("button", { name: "Practise again" });

    fireEvent.click(again);
    await waitFor(() => expect(again.textContent).toBe("Loading…"));
    expect(again.getAttribute("aria-disabled")).toBe("true");
  });

  // Ten answers first: under a loaded suite, more than a test's default five seconds.
  test(
    "starts a new session when Practise names the objective already chosen, at a session's end",
    { timeout: 30_000 },
    async () => {
      let reads = 0;
      renderAt("/c/4732?objective=a", {
        signedIn: true,
        learnerProgress: async () => caughtUp,
        nextActivity: whenChosen(async () => activity("reteach", `r${++reads}`)),
      });
      for (let answered = 1; answered <= 10; answered++) {
        fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
        // The answered question stays until the next replaces it: wait, or its option is pressed.
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      }
      expect(await screen.findByText("Session complete")).toBeTruthy();

      // The same address: still an explicit start, read afresh.
      const next = `Hello, in Spanish? (r${reads + 1})`;
      await practiseGreetings();
      expect(await screen.findByText(next)).toBeTruthy();
      expect(screen.queryByText("Session complete")).toBeNull();
      expect(
        screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuenow"),
      ).toBe("0");
    },
  );

  test("keeps a rest Continue reached from asking an extra question when its end's read fails", async () => {
    const results: (Activity | Error)[] = [
      activity("reteach", "t1"),
      { objective: { id: "a", title: "Greetings" }, retryAfter: 1, reviewable: false },
      new TypeError("Failed to fetch"),
      activity("practise", "t2"),
    ];
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: whenChosen(async () => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Take a short break")).toBeTruthy();

    // The read at the rest's end fails: said, with a retry that asks for nothing extra.
    expect(
      await screen.findByText(
        "Could not load the next question. Try again.",
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Hello, in Spanish? (t2)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing is due on Greetings right now")).toBeTruthy();
    expect(screen.queryByText("Hello, in Spanish? (t2)")).toBeNull();
  });
});

function renderPage(chosen: (objectiveId: string) => Promise<Activity | undefined>) {
  return renderAt("/c/4732?objective=a", {
    signedIn: true,
    learnerProgress: async () => caughtUp,
    nextActivity: whenChosen(chosen),
  });
}
