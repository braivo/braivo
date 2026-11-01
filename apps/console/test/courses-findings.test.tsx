// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A course's page saying what a learner may run into with its tasks as written
// (their `findings`), fixing one through its editor, and Publish asking first
// about them and about objectives it leaves without practice.

import { type AuthoredCourse, type BraivoClient, taskFindings } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { beginners } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

type Task = AuthoredCourse["objectives"][number]["tasks"][number];

/** A task as Braivo reads it back, with the findings it answers for it. */
function task(
  id: string,
  body:
    | { kind: "typed"; prompt: string; accepted: string[] }
    | { kind: "choice"; prompt: string; options: string[]; answer: number },
  published = true,
): Task {
  const findings = taskFindings(body);
  return {
    id,
    ...body,
    citations: [],
    published,
    ...(findings.length > 0 && { findings }),
  };
}

const hello = task("t-hello", { kind: "typed", prompt: "Say hello.", accepted: ["Hello.", "Hi"] });
const colour = task(
  "t-colour",
  { kind: "typed", prompt: "Colour?", accepted: ["colour / color"] },
  false,
);
const paris = task("t-paris", {
  kind: "choice",
  prompt: "Capital of France?",
  options: ["Paris", "paris.", "Rome"],
  answer: 0,
});
/** A clean choice task's body, asking `prompt`. */
const spanish = (prompt: string) => ({
  kind: "choice" as const,
  prompt,
  options: ["Hola", "Adiós"],
  answer: 0,
});
const clean = task("t-clean", spanish("Hello, in Spanish?"));

/** `beginners`, its Greetings practised by `greetings`, its Numbers by `numbers`. */
function course(greetings: Task[], numbers: Task[], published = true) {
  const [first, second] = beginners.objectives;
  return {
    ...beginners,
    published,
    objectives: [
      { ...first!, tasks: greetings },
      { ...second!, tasks: numbers },
    ],
  };
}

describe("a course's checks", () => {
  test("says under each task what a learner may run into, and nothing under a clean one", async () => {
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course([hello, clean, colour], [paris]) },
    });

    const teaches = await screen.findByRole("region", { name: "What it teaches" });
    const greetings = within(teaches).getByRole("article", { name: "1. Greetings" });
    // True with another answer listed: it says what is accepted, not "only".
    expect(
      within(greetings).getByText(
        "“Hello.” is accepted, “Hello” is not: a learner who leaves out the final mark is marked wrong. Check whether it should count too.",
      ),
    ).toBeTruthy();
    const pending = screen.getByRole("region", { name: "Needs review" });
    expect(
      within(pending).getByText(
        "“colour / color” is matched as written, slash or brackets included: a learner who types one part alone is marked wrong unless it is listed too.",
      ),
    ).toBeTruthy();
    expect(
      within(teaches).getByText(
        "The correct option “Paris” differs from “paris.” only in case and a final mark.",
      ),
    ).toBeTruthy();
    // Three tasks with checks; the clean one says nothing.
    expect(document.querySelectorAll("[id^=findings-]")).toHaveLength(3);
    expect(document.getElementById("findings-t-clean")).toBeNull();
    // Only the trailing mark suggests an answer.
    expect(screen.getAllByRole("button", { name: /and add/ })).toHaveLength(1);
  });

  test("adds the suggested answer in the task's editor, saved as its correction, and gone once read again", async () => {
    let corrected = false;
    const fixed = task("t-fixed", {
      kind: "typed",
      prompt: "Say hello.",
      accepted: ["Hello.", "Hi", "Hello"],
    });
    const defineTasks = vi.fn<BraivoClient["defineTasks"]>(async () => {
      corrected = true;
      return [{ id: "t-fixed", added: true, published: true }];
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => course(corrected ? [fixed] : [hello], [clean]),
        defineTasks,
      },
    });

    const add = await screen.findByRole("button", { name: "Edit “Say hello.” and add “Hello”" });
    expect(add.textContent).toBe("Edit and add “Hello”");
    fireEvent.click(add);

    // The editor, with the answer added last and the focus at its end, warning
    // as Edit does that learners are asked the correction from now on.
    const answers = screen.getByLabelText<HTMLTextAreaElement>("Accepted answers, one a line");
    expect(answers.value).toBe("Hello.\nHi\nHello");
    expect(document.activeElement).toBe(answers);
    expect(answers.selectionStart).toBe(answers.value.length);
    expect(
      screen.getByText(/wherever learners are asked it, they are asked the corrected one/),
    ).toBeTruthy();

    // Cancel leaves the task as it was.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Accepted answers, one a line")).toBeNull();
    expect(defineTasks).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit “Say hello.”" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit “Say hello.” and add “Hello”" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Read again: the correction in its place, with nothing to check.
    expect(await screen.findByRole("button", { name: "Edit “Say hello.”" })).toBeTruthy();
    expect(screen.queryByLabelText("Accepted answers, one a line")).toBeNull();
    expect(screen.queryByText(/is accepted, “Hello” is not/)).toBeNull();
    expect(defineTasks).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        tasks: [
          {
            objectiveId: "greetings",
            kind: "typed",
            prompt: "Say hello.",
            accepted: ["Hello.", "Hi", "Hello"],
            citations: [],
            replaces: "t-hello",
          },
        ],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("asks before publishing tasks with checks, or leaving an objective without practice", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    // Numbers' only task waits, left unselected.
    const counting = task("t-one", spanish("One, in Spanish?"), false);
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course([hello, colour], [counting]), publish },
    });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select unpublished task “Colour?”" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish selected (1)" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Some of this may not work as intended:");
    // Neutral: a slash may be intended, as its note says.
    expect(dialog.textContent).toContain("1 of these tasks has checks to review");
    expect(dialog.textContent).toContain("1 objective would have no practice:");
    expect(
      within(within(dialog).getByRole("list", { name: "Objectives without practice" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Numbers"]);
    expect(within(dialog).queryByRole("button", { name: "Not yet" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Publish anyway" }));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: "org-1", courseIds: [], taskIds: ["t-colour"] },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("reviews the tasks sent with checks, focusing the first", async () => {
    const publish = vi.fn();
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course([hello, colour], [paris]), publish },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Review them" }),
    );

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById("findings-t-colour")),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  test("reviews an objective left without practice, at its heading, under What it teaches or Needs review", async () => {
    // Publishing the course alone: Greetings has a published task, Numbers none at
    // all, and Counting only a pending one, left unselected.
    const counting = {
      id: "counting",
      title: "Counting",
      citations: [],
      otherPublishedCourses: [],
    };
    const waiting = task("t-count", spanish("Two, in Spanish?"), false);
    const read = (order: "numbers" | "counting") => {
      const base = course([clean], [], false);
      const [greetings, numbers] = base.objectives;
      const countingObjective = { ...counting, tasks: [waiting] };
      return {
        ...base,
        objectives:
          order === "numbers"
            ? [greetings!, numbers!, countingObjective]
            : [greetings!, countingObjective, numbers!],
      };
    };
    let order: "numbers" | "counting" = "numbers";
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => read(order), publish: vi.fn() },
    });

    const review = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Publish without tasks needing review" }),
      );
      const dialog = await screen.findByRole("alertdialog");
      // The course alone: no count of tasks.
      expect(within(dialog).getByRole("heading").textContent).toBe("Publish the course?");
      fireEvent.click(within(dialog).getByRole("button", { name: "Review them" }));
    };

    // Numbers first: its heading under What it teaches.
    await review();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "2. Numbers" })),
    );

    // Counting first: its heading under Needs review, where its task waits.
    order = "counting";
    cleanup();
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => read(order), publish: vi.fn() },
    });
    await review();
    const pending = screen.getByRole("region", { name: "Needs review" });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(pending).getByRole("heading", { name: "2. Counting" }),
      ),
    );
  });

  test("a correction of an objective's only published task leaves it practised", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const original = task("t-hi", spanish("Hi, in Spanish?"));
    const correction = {
      ...task("t-hi-2", spanish("Hi, in Spanish, informally?"), false),
      replaces: "t-hi",
    };
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course([original, correction], [paris]), publish },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));

    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: "org-1", courseIds: [], taskIds: ["t-hi-2"] },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("publishes without asking when there is nothing to say", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const waiting = task("t-wait", spanish("Bye, in Spanish?"), false);
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course([clean, waiting], [paris]), publish },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));

    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
