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

import { renderAt } from "./render.tsx";

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

function task(intent: "practise" | "reteach", id = "t1"): Activity {
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
function focusing(chosen: (objectiveId: string) => Promise<Activity | undefined>) {
  return (async (_courseId, options) =>
    options?.objectiveId === undefined
      ? undefined
      : chosen(options.objectiveId)) satisfies BraivoClient["nextActivity"];
}

async function practiseGreetings() {
  fireEvent.click(await screen.findByText("2 retained"));
  fireEvent.click(screen.getByRole("link", { name: "Practise Greetings" }));
}

describe("the learn app", () => {
  test("practises an objective chosen where practice pauses, one extra question, then returns to the recommended", async () => {
    const { nextActivity, router } = renderAt("/c/4732", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: focusing(async () => task("practise")),
    });
    expect(await screen.findByText("You're caught up")).toBeTruthy();

    // Each objective offers it, by name.
    fireEvent.click(await screen.findByText("2 retained"));
    const list = screen.getByRole("list");
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Practise Greetings", "Practise Numbers"]);
    await practiseGreetings();

    // The learner's request, never the model's: said so, with the way back.
    expect(await screen.findByText("Hello, in Spanish? (t1)")).toBeTruthy();
    expect(screen.getByText("Extra practice · Greetings")).toBeTruthy();
    expect(screen.getByText("Practising Greetings")).toBeTruthy();
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
    expect(screen.queryByText("Practising Greetings")).toBeNull();
  });

  test("asks an extra question again only when the learner taps Practise again", async () => {
    const answers = [task("practise", "t1"), task("practise", "t2")];
    const { nextActivity } = renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: focusing(async () => answers.shift()),
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
    const answers = [task("reteach", "t1"), task("practise", "t2")];
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: focusing(async () => answers.shift()),
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
    const answers: Activity[] = [
      task("reteach", "t1"),
      { objective: { id: "a", title: "Greetings" }, retryAfter: 1, reviewable: false },
      task("practise", "t2"),
    ];
    renderAt("/c/4732?objective=a", {
      signedIn: true,
      learnerProgress: async () => caughtUp,
      nextActivity: focusing(async () => answers.shift()),
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

  // Ten answers: under a loaded suite, more than a test's default five seconds.
  test(
    "ends the session at its tenth answer, extra questions included",
    { timeout: 30_000 },
    async () => {
      let asked = 0;
      renderAt("/c/4732?objective=a", {
        signedIn: true,
        learnerProgress: async () => caughtUp,
        nextActivity: focusing(async () => task("practise", `t${++asked}`)),
      });
      for (let answered = 1; answered <= 10; answered++) {
        fireEvent.click(await screen.findByRole("button", { name: /Hola/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Practise again" }));
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      }

      expect(await screen.findByText("Session complete")).toBeTruthy();
      // What comes next is the learner's to ask for, never "more to practise".
      expect(screen.getByText("Nothing is due on Greetings right now.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep going" })).toBeNull();
    },
  );

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
          options?.objectiveId === undefined ? task("reteach", "r") : task("practise", "x"),
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
      expect(
        screen.getByRole("progressbar", { name: "Session" }).getAttribute("aria-valuenow"),
      ).toBe("0");
    },
  );
});

function renderPage(chosen: (objectiveId: string) => Promise<Activity | undefined>) {
  return renderAt("/c/4732?objective=a", {
    signedIn: true,
    learnerProgress: async () => caughtUp,
    nextActivity: focusing(chosen),
  });
}
