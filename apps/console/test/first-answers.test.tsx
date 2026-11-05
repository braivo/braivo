// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How learners first answered each task (progress-18), for whoever
// administers the organization: under each published task of a course's and
// an objective's page, an objective's retired tasks beside.

import { type BraivoClient, type FirstAnswersSummary, taskFindings } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { beginners, school } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

const greetingTask = beginners.objectives[0]!.tasks[0]!;
const typedTask = {
  id: "t2",
  kind: "typed" as const,
  prompt: "Goodbye, in Spanish?",
  accepted: ["Adiós"],
  citations: [],
  published: true,
};
const course = {
  ...beginners,
  objectives: [
    { ...beginners.objectives[0]!, tasks: [greetingTask, typedTask] },
    beginners.objectives[1]!,
  ],
};

const summary: FirstAnswersSummary = {
  minLearners: 5,
  tasks: [
    {
      id: greetingTask.id,
      objectiveId: "greetings",
      first: { learners: 11, correct: 2, incorrect: 8, revealed: 1, options: [2, 8] },
      otherTasks: { responses: 13, learners: 7, correct: 9, incorrect: 3, revealed: 1 },
    },
    { id: typedTask.id, objectiveId: "greetings", first: null, otherTasks: null },
  ],
  retired: [],
};

/** The lines under a task, by its card. */
const linesOf = (prompt: string) =>
  within(
    screen
      .getAllByText(prompt)
      .find((title) => title.dataset.slot === "card-title")!
      .closest<HTMLElement>("[data-slot=card]")!,
  )
    .getAllByText(/first answers|Chosen first|Not enough answers/i)
    .map((line) => line.textContent);

describe("learners' first answers", () => {
  test("says each published task's first answers under it, beside its objective's other tasks", async () => {
    const readFirstAnswers = vi.fn<BraivoClient["readFirstAnswers"]>(async () => summary);
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course, readFirstAnswers },
    });

    expect(await screen.findByText(/First answers from 11 learners/)).toBeTruthy();
    expect(readFirstAnswers).toHaveBeenCalledWith(
      { organizationId: "org-1", courseId: "course-1" },
      expect.anything(),
    );
    expect(linesOf("Hello, in Spanish?")).toEqual([
      "First answers from 11 learners: 2 correct, 8 incorrect, 1 asked to see the answer.",
      "Chosen first: A: 2, · B: 8",
      "The objective's other questions: 9 correct, 3 incorrect, 1 asked to see the answer, of 13 first answers from 7 learners.",
    ]);
    expect(linesOf("Goodbye, in Spanish?")).toEqual([
      "Not enough answers yet (fewer than 5 learners).",
    ]);
    // Counts, never a verdict or a cause.
    for (const prompt of ["Hello, in Spanish?", "Goodbye, in Spanish?"]) {
      for (const line of linesOf(prompt)) {
        expect(line).not.toMatch(/wrong|mislead|broken|confus|error|bad|poor|problem/i);
      }
    }
    // How they are counted, said once.
    const caveats = screen.getAllByText("How first answers are counted");
    expect(caveats).toHaveLength(1);
    fireEvent.click(caveats[0]!);
    expect(
      screen.getByText(/aren't directly comparable\. Use them to choose what to review\./),
    ).toBeTruthy();
  });

  test("says nothing of them where no task has enough answers, but the floor", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => course,
        readFirstAnswers: async () => ({
          ...summary,
          tasks: summary.tasks.map((task) => ({ ...task, first: null, otherTasks: null })),
        }),
      },
    });

    expect(
      await screen.findAllByText("Not enough answers yet (fewer than 5 learners)."),
    ).toHaveLength(2);
    expect(screen.queryByText("How first answers are counted")).toBeNull();
  });

  test("warns, editing a task, that its first answers stay with this version", async () => {
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course, readFirstAnswers: async () => summary },
    });

    await screen.findByText(/First answers from 11 learners/);
    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    expect(
      screen.getByText(
        "Its first answers stay with this version; the corrected one starts with none.",
      ),
    ).toBeTruthy();
  });

  test("shows an author none of it, never reading it", async () => {
    const readFirstAnswers = vi.fn<BraivoClient["readFirstAnswers"]>(async () => summary);
    renderAt("/example/courses/course-1", {
      organizations: [{ ...school, administers: false }],
      braivo: { readCourse: async () => course, readFirstAnswers },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Beginners" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    expect(screen.queryByText(/first answers|Not enough answers/i)).toBeNull();
    expect(readFirstAnswers).not.toHaveBeenCalled();
  });

  test("keeps the page whole when they cannot be read, saying so", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => course,
        readFirstAnswers: async () => {
          throw new Error("down");
        },
      },
    });

    expect(await screen.findByText("Learners' first answers could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Hello, in Spanish?")).toBeTruthy();
    expect(screen.queryByText(/Not enough answers/)).toBeNull();
  });

  test("lists an objective's retired tasks, newest retirement first, with the answers each kept", async () => {
    const readFirstAnswers = vi.fn<BraivoClient["readFirstAnswers"]>(async () => ({
      ...summary,
      retired: [
        {
          id: "old-2",
          objectiveId: "greetings",
          kind: "choice",
          prompt: "Hello, in Spanish (second)?",
          options: ["Hola", "Adiós"],
          answer: 1,
          retiredAt: "2026-06-03T10:00:00.000Z",
          first: { learners: 6, correct: 1, incorrect: 5, revealed: 0, options: [5, 1] },
        },
        {
          id: "old-1",
          objectiveId: "greetings",
          kind: "typed",
          prompt: "Hello, in Spanish (first)?",
          accepted: ["Ola"],
          retiredAt: "2026-06-01T10:00:00.000Z",
          first: null,
        },
      ],
    }));
    renderAt("/example/objectives/greetings", {
      braivo: {
        listTasks: async () => [greetingTask, typedTask],
        listObjectives: async () => [
          { id: "greetings", title: "Greetings", courseIds: ["course-1"], pendingTaskCount: 0 },
        ],
        listCourses: async () => [],
        listSources: async () => beginners.sources,
        readFirstAnswers,
      },
    });

    const retired = await screen.findByRole("region", { name: "Retired questions" });
    expect(readFirstAnswers).toHaveBeenCalledWith(
      { organizationId: "org-1", objectiveId: "greetings" },
      expect.anything(),
    );
    const cards = within(retired).getAllByText(/Hello, in Spanish \(/);
    expect(cards.map((card) => card.textContent)).toEqual([
      "Hello, in Spanish (second)?",
      "Hello, in Spanish (first)?",
    ]);
    expect(within(retired).getByText("Retired Jun 3, 2026")).toBeTruthy();
    expect(linesOf("Hello, in Spanish (second)?")).toEqual([
      "First answers from 6 learners: 1 correct, 5 incorrect, 0 asked to see the answer.",
      "Chosen first: A: 5, · B: 1",
    ]);
    expect(linesOf("Hello, in Spanish (first)?")).toEqual([
      "Not enough answers yet (fewer than 5 learners).",
    ]);
    // The live tasks keep theirs above.
    expect(linesOf("Hello, in Spanish?")).toHaveLength(3);
  });

  test("says how they are counted where only a retired task has enough answers", async () => {
    renderAt("/example/objectives/greetings", {
      braivo: {
        listTasks: async () => [greetingTask, typedTask],
        listObjectives: async () => [
          { id: "greetings", title: "Greetings", courseIds: ["course-1"], pendingTaskCount: 0 },
        ],
        listCourses: async () => [],
        listSources: async () => beginners.sources,
        readFirstAnswers: async () => ({
          minLearners: 5,
          tasks: summary.tasks.map((task) => ({ ...task, first: null, otherTasks: null })),
          retired: [
            {
              id: "old-1",
              objectiveId: "greetings",
              kind: "typed",
              prompt: "Hello, in Spanish (first)?",
              accepted: ["Ola"],
              retiredAt: "2026-06-01T10:00:00.000Z",
              first: { learners: 5, correct: 1, incorrect: 4, revealed: 0 },
            },
          ],
        }),
      },
    });

    expect(await screen.findByText(/First answers from 5 learners/)).toBeTruthy();
    expect(screen.getAllByText("How first answers are counted")).toHaveLength(1);
  });

  describe("Questions to review (progress-19)", () => {
    /** A published typed task, with the findings Braivo reads back for it. */
    const typed = (id: string, prompt: string, accepted = ["x"]) => {
      const body = { kind: "typed" as const, prompt, accepted };
      const findings = taskFindings(body);
      return {
        id,
        ...body,
        citations: [],
        published: true,
        ...(findings.length > 0 && { findings }),
      };
    };
    // Twelve tasks over the floor, one under it, across two objectives.
    const greetingTasks = Array.from({ length: 7 }, (_, index) =>
      typed(`g${index}`, `Greeting ${index}?`),
    );
    const numberTasks = [
      ...Array.from({ length: 5 }, (_, index) => typed(`n${index}`, `Number ${index}?`)),
      typed("n-few", "Few answers?"),
      // A check BRV-13's findings raise: the slash is matched as written.
      typed("n-slash", "Colour?", ["colour / color"]),
    ];
    const reviewedCourse = {
      ...beginners,
      objectives: [
        { ...beginners.objectives[0]!, tasks: greetingTasks },
        { ...beginners.objectives[1]!, tasks: numberTasks },
      ],
    };
    const counts = (learners: number, incorrect: number) => ({
      learners,
      correct: learners - incorrect,
      incorrect,
      revealed: 0,
    });
    const reviewSummary: FirstAnswersSummary = {
      minLearners: 5,
      tasks: [
        // Shares of incorrect first answers: g0 9/10, g1..g6 descending, ties by more learners.
        { id: "g0", objectiveId: "greetings", first: counts(10, 9), otherTasks: null },
        { id: "g1", objectiveId: "greetings", first: counts(5, 4), otherTasks: null },
        { id: "g2", objectiveId: "greetings", first: counts(10, 8), otherTasks: null },
        { id: "g3", objectiveId: "greetings", first: counts(10, 7), otherTasks: null },
        { id: "g4", objectiveId: "greetings", first: counts(10, 6), otherTasks: null },
        { id: "g5", objectiveId: "greetings", first: counts(10, 5), otherTasks: null },
        { id: "g6", objectiveId: "greetings", first: counts(10, 4), otherTasks: null },
        { id: "n0", objectiveId: "numbers", first: counts(10, 3), otherTasks: null },
        { id: "n1", objectiveId: "numbers", first: counts(10, 2), otherTasks: null },
        { id: "n2", objectiveId: "numbers", first: counts(10, 1), otherTasks: null },
        // Past the cap of 10.
        { id: "n3", objectiveId: "numbers", first: counts(20, 1), otherTasks: null },
        // None incorrect: nothing to review.
        { id: "n4", objectiveId: "numbers", first: counts(10, 0), otherTasks: null },
        // Under the floor, however wrong.
        { id: "n-few", objectiveId: "numbers", first: null, otherTasks: null },
        { id: "n-slash", objectiveId: "numbers", first: counts(10, 9), otherTasks: null },
      ],
      retired: [],
    };

    function renderReview(braivo: object = {}) {
      return renderAt("/example/courses/course-1", {
        braivo: {
          readCourse: async () => reviewedCourse,
          readFirstAnswers: async () => reviewSummary,
          listReportedTasks: async () => ({
            tasks: [
              {
                id: "g2",
                objectiveId: "greetings",
                kind: "typed" as const,
                prompt: "Greeting 2?",
                accepted: ["x"],
                reportCount: 3,
                reasonCount: 1,
                reports: [],
              },
            ],
            more: false,
          }),
          ...braivo,
        },
      });
    }

    test("lists the 10 most often answered incorrectly first, ties by more learners, with reports and checks", async () => {
      renderReview();

      const list = await screen.findByRole("region", { name: "Questions to review" });
      // What the list is for, beside it rather than only in the collapsed note.
      expect(within(list).getByText(/Learners meet questions at different points/)).toBeTruthy();
      const links = within(list).getAllByRole("link");
      expect(
        links.map((link) => [link.textContent?.split(/(?<=\?)/)[0], link.getAttribute("href")]),
      ).toEqual([
        ["Greeting 0?", "#task-g0"],
        ["Colour?", "#task-n-slash"],
        ["Greeting 2?", "#task-g2"],
        // 4 of 5 ties 8 of 10: the one more learners answered first.
        ["Greeting 1?", "#task-g1"],
        ["Greeting 3?", "#task-g3"],
        ["Greeting 4?", "#task-g4"],
        ["Greeting 5?", "#task-g5"],
        ["Greeting 6?", "#task-g6"],
        ["Number 0?", "#task-n0"],
        ["Number 1?", "#task-n1"],
      ]);
      expect(
        within(list).getByRole("link", {
          name: "Greeting 2?",
          description: "8 of 10 first answers incorrect · Greetings · Reported by 3 learners",
        }),
      ).toBeTruthy();
      expect(
        within(list).getByRole("link", {
          name: "Colour?",
          description: "9 of 10 first answers incorrect · Numbers · 1 check",
        }),
      ).toBeTruthy();
      // Counts and facts, never a verdict.
      expect(list.textContent).not.toMatch(/wrong|mislead|broken|bad|poor/i);
    });

    test("focuses the task a link leads to", async () => {
      renderReview();

      const list = await screen.findByRole("region", { name: "Questions to review" });
      fireEvent.click(within(list).getByRole("link", { name: "Number 1?" }));
      expect(document.activeElement?.id).toBe("task-n1");
    });

    test("is absent while no task has enough answers", async () => {
      renderReview({
        readFirstAnswers: async () => ({
          ...reviewSummary,
          tasks: reviewSummary.tasks.map((task) => ({ ...task, first: null })),
        }),
      });
      expect(await screen.findAllByText(/Not enough answers yet/)).not.toHaveLength(0);
      expect(screen.queryByRole("region", { name: "Questions to review" })).toBeNull();
    });
  });
});
