// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type LearnerProgressReport } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { members, courseProgress } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

/** A moment as the learner report shows it, compact. */
function dated(at: string) {
  return new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

describe("the console", () => {
  test("asks nothing about a course's learners until the course is its own", async () => {
    const progress = vi.fn(courseProgress);
    renderAt("/example/courses/elsewhere/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        courseProgress: progress,
      },
    });

    expect(
      await screen.findByText("This course does not exist, or its progress is not yours to see."),
    ).toBeTruthy();
    expect(progress.mock.calls).toEqual([]);
  });

  test("reads a course's progress as not found when Braivo refuses its learners", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        courseProgress: async () => {
          throw new BraivoError(404, "Braivo answered 404.");
        },
      },
    });

    expect(
      await screen.findByText("This course does not exist, or its progress is not yours to see."),
    ).toBeTruthy();
  });

  test("counts each learner's objectives by standing, linking to their progress", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
      },
    });

    const learners = await screen.findByRole("table", { name: "Learners" });
    const [header, ...rows] = within(learners).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Learner",
      "Not started",
      "Learning",
      "Repeated misses",
      "Retained",
      "Due for review",
    ]);
    expect(
      rows.map((row) => {
        const learner = within(row).getByRole("rowheader");
        return [
          within(learner).getByRole("link").textContent,
          ...within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ];
      }),
    ).toEqual([
      // No repeated misses: blank, not 0.
      ["Lee Learner", "0", "1", "", "0", "1"],
      ["Olive Owner", "2", "0", "", "0", "0"],
    ]);
    // Every member, staff included, and said so.
    expect(screen.getByText(/2 members of Example School, staff included/)).toBeTruthy();
    expect(within(learners).getByRole("link", { name: "Lee Learner" }).getAttribute("href")).toBe(
      "/example/courses/course-1/learners/u2",
    );
  });

  test("sends no one to the link of a course learners cannot open, nor says its members study it", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          {
            id: "course-1",
            number: 4732,
            title: "Beginners",
            urlLabel: "beginners",
            published: false,
          },
        ],
        courseProgress: async () => ({ ...(await courseProgress()), open: false }),
      },
    });

    expect(await screen.findByText("Learners can't open this course for now.")).toBeTruthy();
    expect(
      screen.getByText(/every member can study this course once it is open to learners\./),
    ).toBeTruthy();
    expect(screen.queryByText(/Learners practise it at/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  });

  test("counts each objective's learners by standing, in content order", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
      },
    });

    const objectives = await screen.findByRole("table", { name: "Progress by objective" });
    const [header, ...rows] = within(objectives).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Objective",
      "Not started",
      "Learning",
      "Repeated misses",
      "Retained",
      "Due for review",
    ]);
    expect(
      rows.map((row) => [
        within(row).getByRole("rowheader").textContent,
        ...within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ]),
    ).toEqual([
      ["Greetings", "1", "1", "", "0", "0"],
      ["Numbers", "1", "0", "", "0", "1"],
    ]);
  });

  test("draws each row's counts as one bar under its name, coloured as its column's heading", async () => {
    const standings = (unseen: number, acquiring: number, retained: number, due: number) => ({
      unseen,
      acquiring,
      retained,
      due,
    });
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        courseProgress: async () => ({
          ...(await courseProgress()),
          learners: [
            { ...members[1]!, standings: standings(1, 2, 4, 3), repeatedMisses: 0 },
            { ...members[0]!, standings: standings(0, 0, 0, 0), repeatedMisses: 0 },
          ],
          objectives: [
            {
              objectiveId: "greetings",
              title: "Greetings",
              standings: standings(0, 0, 2, 0),
              repeatedMisses: [],
            },
            {
              objectiveId: "numbers",
              title: "Numbers",
              standings: standings(1, 0, 0, 1),
              repeatedMisses: [],
            },
          ],
        }),
      },
    });

    // ADR 0037's colours, in the columns' order.
    const colours = {
      unseen: "bg-chart-4",
      acquiring: "bg-chart-3",
      retained: "bg-chart-1",
      due: "bg-chart-2",
    };
    for (const [name, expected] of [
      [
        "Learners",
        {
          "Lee Learner": [
            ["unseen", "1"],
            ["acquiring", "2"],
            ["retained", "4"],
            ["due", "3"],
          ],
          "Olive Owner": null,
        },
      ],
      [
        "Progress by objective",
        {
          Greetings: [["retained", "2"]],
          Numbers: [
            ["unseen", "1"],
            ["due", "1"],
          ],
        },
      ],
    ] as const) {
      const table = await screen.findByRole("table", { name });
      const [header, ...rows] = within(table).getAllByRole("row");
      // Each heading's swatch is its standing's colour in the bars.
      const swatches = within(header!)
        .getAllByRole("columnheader")
        .filter((cell) => cell.textContent !== "Repeated misses")
        .slice(1)
        .map((cell) => cell.querySelector(":scope > [aria-hidden]")!);
      expect(swatches.map((swatch) => swatch.getAttribute("aria-hidden"))).toEqual(
        Array(4).fill("true"),
      );
      Object.values(colours).forEach((colour, index) =>
        expect(swatches[index]!.classList.contains(colour)).toBe(true),
      );
      const bars = Object.fromEntries(
        rows.map((row) => {
          const label = within(row).getByRole("rowheader");
          const bar = label.querySelector<HTMLElement>(":scope > [aria-hidden]");
          if (!bar) return [label.textContent, null];
          expect(bar.getAttribute("aria-hidden")).toBe("true");
          const segments = [...bar.querySelectorAll<HTMLElement>(":scope > *")].map(
            ({ dataset, classList, style }) => {
              const standing = dataset.standing as keyof typeof colours;
              expect(classList.contains(colours[standing])).toBe(true);
              return [standing, style.flexGrow];
            },
          );
          // The bar is no part of the row's name.
          return [label.textContent, segments];
        }),
      );
      expect(bars).toEqual(expected);
      for (const label of Object.keys(expected)) {
        expect(within(table).getByRole("rowheader", { name: label })).toBeTruthy();
      }
    }
  });

  test("shows where a learner stands on each objective, by title", async () => {
    const report: LearnerProgressReport = {
      modelVersion: "v1",
      asOf: "2026-06-01T00:00:00.000Z",
      repeatedMissesThreshold: 3,
      objectives: [
        {
          objectiveId: "o1",
          title: "Greetings",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 1,
          retrievability: 0.42,
          due: true,
          dueAt: "2026-06-02T00:00:00.001Z",
          evidence: [
            { outcome: "failure", at: "2026-05-30T00:00:00.000Z" },
            { outcome: "failure", at: "2026-05-31T00:00:00.000Z" },
            { outcome: "success", at: "2026-06-01T00:00:00.000Z" },
          ],
        },
        { objectiveId: "o2", title: "Numbers", phase: "unseen", evidence: [] },
        // Retained, not due: its recall shows under it too, 100% included.
        {
          objectiveId: "o3",
          title: "Colours",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 1,
          retrievability: 1,
          due: false,
          dueAt: "2026-06-02T00:00:00.001Z",
          evidence: [{ outcome: "success", at: "2026-06-01T00:00:00.000Z" }],
        },
      ],
    };
    const learnerProgress = vi.fn(async () => report);
    const listCourses = vi.fn(async () => [
      { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
    ]);
    const listMembers = vi.fn(async () => members);
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: { learnerProgress, listCourses, listMembers },
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    // Named in the page, not only the tab, and leading back to the course's other learners.
    expect(screen.getByRole("link", { name: "Beginners" }).getAttribute("href")).toBe(
      "/example/courses/course-1/progress",
    );
    expect(screen.queryByText(/no objectives yet/i)).toBeNull();
    // Once for the page, not beside each percentage.
    expect(screen.getAllByText(/a model estimate, not a test score/)).toHaveLength(1);
    // A list, each objective a heading over its fields, named beside their
    // values: on a phone, no column of a table starts off screen.
    const list = screen.getByRole("list", { name: "Lee Learner" });
    const objective = (title: string) => {
      const item = screen.getByRole("heading", { level: 2, name: title }).closest("li")!;
      expect(item.parentElement).toBe(list);
      return item;
    };
    const fields = (item: HTMLElement) =>
      Object.fromEntries(
        [...item.querySelectorAll(":scope > dl > dt")].map((term) => [
          term.textContent,
          term.nextElementSibling!.tagName === "DD" ? term.nextElementSibling!.textContent : null,
        ]),
      );
    const greetings = objective("Greetings");
    const numbers = objective("Numbers");
    // The last evidence may have been graded outside Braivo, so not "Last attempted".
    expect(fields(greetings)).toMatchObject({
      // The standing, then the recall predicted under it, labelled as such.
      Standing: "Due for reviewEstimated recall now: 42%",
      "Last evidence": dated("2026-06-01T00:00:00.000Z"),
      "Review due": dated("2026-06-02T00:00:00.001Z"),
    });
    // Counted, so a learner who failed many times does not read like one who failed once.
    const counted = within(greetings).getByLabelText("Greetings: 1 success, 2 failures");
    expect(counted.textContent).toBe("1 success, 2 failures");
    // Dated on request, newest first.
    const details = counted.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(counted);
    expect(details.open).toBe(true);
    expect(
      within(details)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `${dated("2026-06-01T00:00:00.000Z")}: success`,
      `${dated("2026-05-31T00:00:00.000Z")}: failure`,
      `${dated("2026-05-30T00:00:00.000Z")}: failure`,
    ]);
    expect(fields(objective("Colours")).Standing).toBe("RetainedEstimated recall now: 100%");
    expect(fields(numbers)).toEqual({
      Standing: "Not started",
      "Last evidence": "—",
      Evidence: "—",
      "Review due": "—",
    });
    // Every id here is an interchangeable string, so a read scoped to the wrong
    // one type-checks; these assertions are what hold the tenant boundary.
    const options = { signal: expect.any(AbortSignal) };
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "course-1", learnerId: "u2" },
      options,
    );
    expect(listCourses).toHaveBeenCalledWith("org-1", options);
    expect(listMembers).toHaveBeenCalledWith("org-1", options);
  });

  test("says under a standing still learning how often it was missed, from the report's threshold", async () => {
    const acquiring = (
      objectiveId: string,
      title: string,
      misses?: LearnerProgressReport["objectives"][number]["misses"],
    ) => ({
      objectiveId,
      title,
      phase: "acquiring" as const,
      lastEvidenceAt: "2026-05-28T09:00:00.000Z",
      ...(misses && { misses }),
      evidence: [{ outcome: "failure" as const, at: "2026-05-28T09:00:00.000Z" }],
    });
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: {
        learnerProgress: async (): Promise<LearnerProgressReport> => ({
          modelVersion: "v1",
          asOf: "2026-06-01T12:05:00.000Z",
          repeatedMissesThreshold: 3,
          objectives: [
            acquiring("o1", "Greetings", {
              count: 4,
              lastMissAt: "2026-05-28T09:00:00.000Z",
              everSucceeded: true,
            }),
            acquiring("o2", "Numbers", {
              count: 3,
              lastMissAt: "2026-05-28T09:00:00.000Z",
              everSucceeded: false,
            }),
            // Below the threshold: no line.
            acquiring("o3", "Colours", {
              count: 2,
              lastMissAt: "2026-05-28T09:00:00.000Z",
              everSucceeded: false,
            }),
          ],
        }),
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        listMembers: async () => members,
      },
    });

    const standing = (title: string) => {
      const item = screen.getByRole("heading", { level: 2, name: title }).closest("li")!;
      return item.querySelector("dt + dd")!.textContent;
    };
    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    const latest = new Date("2026-05-28T09:00:00.000Z").toLocaleDateString("en", {
      dateStyle: "medium",
    });
    expect(standing("Greetings")).toBe(
      `Learning4 misses since the last correct answer, latest ${latest}`,
    );
    expect(standing("Numbers")).toBe(`Learning3 misses, no correct answer yet, latest ${latest}`);
    expect(standing("Colours")).toBe("Learning");
    // The moment assessed, not today, so with its date.
    expect(screen.getByText(`As of ${dated("2026-06-01T12:05:00.000Z")}`)).toBeTruthy();
  });

  test("opened at an objective, focuses its heading", async () => {
    const asOf = new Date().toISOString();
    renderAt("/example/courses/course-1/learners/u2#objective-o2", {
      braivo: {
        learnerProgress: async (): Promise<LearnerProgressReport> => ({
          modelVersion: "v1",
          asOf,
          repeatedMissesThreshold: 3,
          objectives: ["o1", "o2", "o3"].map((objectiveId) => ({
            objectiveId,
            title: `Objective ${objectiveId}`,
            phase: "unseen" as const,
            evidence: [],
          })),
        }),
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        listMembers: async () => members,
      },
    });

    const heading = await screen.findByRole("heading", { level: 2, name: "Objective o2" });
    expect(heading.id).toBe("objective-o2");
    expect(document.activeElement).toBe(heading);
    // Dated even today: a page kept open past midnight would misdate a time alone.
    expect(screen.getByText(`As of ${dated(asOf)}`)).toBeTruthy();
  });

  test("reads progress Braivo will not show as not found", async () => {
    renderAt("/example/courses/course-1/learners/u9", {
      braivo: {
        learnerProgress: async () => {
          throw new BraivoError(404, "not found");
        },
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
      },
    });

    expect(
      await screen.findByText(
        "This learner does not exist, or their progress is not yours to see.",
      ),
    ).toBeTruthy();
  });

  test("says a course without objectives has nothing to report, rather than an empty list", async () => {
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: {
        learnerProgress: async () => ({
          modelVersion: "v1",
          asOf: "2026-06-01T00:00:00.000Z",
          repeatedMissesThreshold: 3,
          objectives: [],
        }),
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        listMembers: async () => members,
      },
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    expect(screen.getByText(/no objectives yet/i)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Lee Learner" })).toBeNull();
  });
});
