// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// How learners first answered each task (progress-18), for whoever
// administers the organization: under each published task of a course's and
// an objective's page, an objective's retired tasks beside.

import type { BraivoClient, FirstAnswersSummary } from "@braivo/server/client";
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
  within(screen.getByText(prompt).closest<HTMLElement>("[data-slot=card]")!)
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
});
