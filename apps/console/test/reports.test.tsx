// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// Learners' reports of tasks, for whoever administers the organization
// (access-46, ADR 0052): listed on its page, under each task on a course's and
// an objective's page, resolved there.

import type { BraivoClient, ReportedTask } from "@braivo/server/client";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { annex, beginners, school } from "./fixtures.ts";
import { renderAt, stall } from "./render.tsx";

/** The course's own task, reported. */
const greetingTask = beginners.objectives[0]!.tasks[0]!;
const typedTask = {
  id: "t2",
  kind: "typed" as const,
  prompt: "Capital of the United States' largest city?",
  accepted: ["New York"],
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
const sources = beginners.sources;

const report = (
  id: string,
  reason: ReportedTask["reports"][number]["reason"],
  response: ReportedTask["reports"][number]["response"],
  note?: string,
) => ({ id, reason, response, at: "2026-06-01T10:00:00.000Z", ...(note && { note }) });

const reportedGreeting: ReportedTask = {
  id: greetingTask.id,
  objectiveId: "greetings",
  kind: "choice",
  prompt: greetingTask.prompt,
  options: greetingTask.options,
  answer: 0,
  reportCount: 2,
  reasonCount: 2,
  reports: [
    report("r2", "key-wrong", { choice: 1 }, "Adiós can be a greeting\nin passing."),
    report("r1", "confusing", { reveal: true }),
  ],
};

/** The typed task, reported with each answer. */
const reportedTyped = (...responses: string[]): ReportedTask => ({
  id: typedTask.id,
  objectiveId: "greetings",
  kind: "typed",
  prompt: typedTask.prompt,
  accepted: typedTask.accepted,
  reportCount: responses.length,
  reasonCount: 1,
  reports: responses.map((text, index) => report(`t${index}`, "answer-correct", { text })),
});

const coursePage = (braivo: object) =>
  renderAt("/example/courses/course-1", {
    braivo: { readCourse: async () => course, ...braivo },
  });

describe("learners' reports", () => {
  test("lists the organization's reported tasks, each leading to its reports on its objective's page", async () => {
    const listReportedTasks = vi.fn<BraivoClient["listReportedTasks"]>(async () => ({
      tasks: [reportedGreeting],
      more: true,
    }));
    renderAt("/example", {
      braivo: {
        listCourses: async () => [],
        listReportedTasks,
        listObjectives: async () => [
          { id: "greetings", title: "Greetings", courseIds: [], pendingTaskCount: 0 },
        ],
        listTasks: async () => [greetingTask],
        listSources: async () => sources,
      },
    });

    const section = await screen.findByRole("region", { name: "Reported by learners" });
    expect(listReportedTasks).toHaveBeenCalledWith({ organizationId: "org-1" }, expect.anything());
    expect(
      within(section).getByText("Showing the 1 most recently reported tasks, not every one."),
    ).toBeTruthy();
    const link = within(section).getByRole("link", {
      name: "Hello, in Spanish?",
      description: "2 learners · The expected answer seems wrong · +1 more reason",
    });

    fireEvent.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Greetings" })).toBeTruthy();
    // Open on arrival, its reports read for this objective alone.
    const reports = await screen.findByText("Reported by 2 learners");
    expect(reports.closest("details")?.open).toBe(true);
    expect(listReportedTasks).toHaveBeenLastCalledWith(
      { organizationId: "org-1", objectiveId: "greetings" },
      expect.anything(),
    );
  });

  test("shows an author nothing of them, not even a count, never reading them", async () => {
    const listReportedTasks = vi.fn<BraivoClient["listReportedTasks"]>(async () => ({
      tasks: [reportedGreeting],
      more: false,
    }));
    renderAt("/example/courses/course-1", {
      organizations: [{ ...school, administers: false }],
      braivo: { readCourse: async () => course, listReportedTasks },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Beginners" })).toBeTruthy();
    expect(screen.queryByText(/Reported by/)).toBeNull();
    expect(listReportedTasks).not.toHaveBeenCalled();
  });

  test("lists a task's reports under it on a course's page: reason, answer, note, and date, naming no one", async () => {
    coursePage({ listReportedTasks: async () => ({ tasks: [reportedGreeting], more: false }) });

    fireEvent.click(await screen.findByText("Reported by 2 learners"));
    const reports = screen.getByText("Reported by 2 learners").closest("details")!;
    const items = within(reports).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "The expected answer seems wrongChose: Adiós · Jun 1, 2026“Adiós can be a greeting\nin passing.”",
      "The question or explanation is confusingShowed the answer · Jun 1, 2026",
    ]);
    // Only the reported task has reports.
    expect(screen.getAllByText(/Reported by/)).toHaveLength(1);
  });

  test("offers a typed answer reported correct to the accepted ones, prefilled in the editor, saved as a correction", async () => {
    const defineTasks = vi.fn<BraivoClient["defineTasks"]>(async () => [
      { id: "t3", added: true, published: true },
    ]);
    coursePage({
      listReportedTasks: async () => ({ tasks: [reportedTyped("New\nYork City")], more: false }),
      defineTasks,
    });

    fireEvent.click(await screen.findByText("Reported by 1 learner"));
    // Spaced as stored answers are: one answer, never two lines.
    fireEvent.click(
      screen.getByRole("button", { name: "Add “New York City” to accepted answers" }),
    );

    const accepted = await screen.findByRole("textbox", { name: "Accepted answers, one a line" });
    expect(accepted).toHaveProperty("value", "New York\nNew York City");
    expect(document.activeElement).toBe(accepted);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(defineTasks).toHaveBeenCalled());
    expect(defineTasks.mock.calls[0]![0].tasks[0]).toMatchObject({
      replaces: "t2",
      accepted: ["New York", "New York City"],
    });
  });

  test.each([
    ["blank", " \n "],
    ["over 200 characters", "x".repeat(201)],
    ["accepted already, as answers compare", "  new   york "],
  ])("offers no answer to accept when it is %s", async (_case, text) => {
    coursePage({ listReportedTasks: async () => ({ tasks: [reportedTyped(text)], more: false }) });

    fireEvent.click(await screen.findByText("Reported by 1 learner"));
    expect(screen.queryByRole("button", { name: /to accepted answers/ })).toBeNull();
  });

  test("offers no answer to accept once a task has twenty", async () => {
    const full = Array.from({ length: 20 }, (_, index) => `Answer ${index}`);
    coursePage({
      readCourse: async () => ({
        ...course,
        objectives: [
          { ...course.objectives[0]!, tasks: [{ ...typedTask, accepted: full }] },
          course.objectives[1]!,
        ],
      }),
      listReportedTasks: async () => ({
        tasks: [{ ...reportedTyped("Another"), accepted: full }],
        more: false,
      }),
    });

    fireEvent.click(await screen.findByText("Reported by 1 learner"));
    expect(screen.queryByRole("button", { name: /to accepted answers/ })).toBeNull();
  });

  test("shows every report on request, and dismisses exactly those shown, saying so", async () => {
    const preview = { ...reportedGreeting, reportCount: 3 };
    const whole = {
      ...reportedGreeting,
      reportCount: 3,
      reports: [...reportedGreeting.reports, report("r0", "other", { choice: 0 }, "Hm.")],
    };
    let open = true;
    const listReportedTasks = vi.fn<BraivoClient["listReportedTasks"]>(async (input) => ({
      tasks: open ? [input.taskId ? whole : preview] : [],
      more: false,
    }));
    const dismissReports = vi.fn<BraivoClient["dismissReports"]>(async () => {
      open = false;
    });
    coursePage({ listReportedTasks, dismissReports });

    fireEvent.click(await screen.findByText("Reported by 3 learners"));
    expect(screen.getByRole("button", { name: "Dismiss these 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 3 reports" }));
    const dismiss = await screen.findByRole("button", { name: "Dismiss reports" });
    expect(screen.getByText("“Hm.”")).toBeTruthy();

    fireEvent.click(dismiss);
    expect(await screen.findByText("Reports dismissed. The task is unchanged.")).toBeTruthy();
    expect(dismissReports).toHaveBeenCalledWith(
      { organizationId: "org-1", reportIds: ["r2", "r1", "r0"] },
      expect.anything(),
    );
    expect(screen.getByText("Reports dismissed. The task is unchanged.").getAttribute("role")).toBe(
      "status",
    );
    expect(screen.queryByText(/Reported by/)).toBeNull();
    // Its button gone with the reports, the status holds the focus.
    expect(document.activeElement).toBe(
      screen.getByText("Reports dismissed. The task is unchanged."),
    );
  });

  test("reads the page again when Show all finds the reports closed meanwhile, saying so", async () => {
    let open = true;
    const listReportedTasks = vi.fn<BraivoClient["listReportedTasks"]>(async (input) => {
      // Another administrator dismissed them while this page was open.
      if (input.taskId) open = false;
      return { tasks: open ? [{ ...reportedGreeting, reportCount: 3 }] : [], more: false };
    });
    coursePage({ listReportedTasks });

    fireEvent.click(await screen.findByText("Reported by 3 learners"));
    fireEvent.click(screen.getByRole("button", { name: "Show all 3 reports" }));

    expect(await screen.findByText("These reports were closed meanwhile.")).toBeTruthy();
    expect(screen.queryByText(/Reported by/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("These reports were closed meanwhile."));
  });

  test("shows a corrected task's reports beside its correction where the page shows it alone, never twice", async () => {
    const correction = {
      ...typedTask,
      id: "t3",
      accepted: ["New York", "NYC"],
      published: false,
      replaces: typedTask.id,
    };
    const withCorrection = {
      ...course,
      objectives: [
        { ...course.objectives[0]!, tasks: [greetingTask, typedTask, correction] },
        course.objectives[1]!,
      ],
    };
    const braivo = {
      readCourse: async () => withCorrection,
      listReportedTasks: async () => ({
        tasks: [{ ...reportedTyped("NY"), pendingCorrectionId: "t3" }],
        more: false,
      }),
    };

    // Narrowed to tasks without an explanation, the original shows only as published now.
    renderAt("/example/courses/course-1?without=explanation", { braivo });
    fireEvent.click(await screen.findByText("Reported by 1 learner"));
    expect(screen.getByRole("button", { name: "Dismiss report" })).toBeTruthy();
    // Its editor is not offered there, as its Edit is not.
    expect(screen.queryByRole("button", { name: /to accepted answers/ })).toBeNull();
    expect(screen.getAllByText("Reported by 1 learner")).toHaveLength(1);
  });

  test("shows a corrected task's reports once, under the task, when the page shows it", async () => {
    const correction = { ...typedTask, id: "t3", published: false, replaces: typedTask.id };
    coursePage({
      readCourse: async () => ({
        ...course,
        objectives: [
          { ...course.objectives[0]!, tasks: [greetingTask, typedTask, correction] },
          course.objectives[1]!,
        ],
      }),
      listReportedTasks: async () => ({
        tasks: [{ ...reportedTyped("NY"), pendingCorrectionId: "t3" }],
        more: false,
      }),
    });

    expect(await screen.findAllByText("Reported by 1 learner")).toHaveLength(1);
  });

  test("counts every reason of a task's open reports on the organization's page, not only those listed", async () => {
    renderAt("/example", {
      braivo: {
        listCourses: async () => [],
        listObjectives: async () => [],
        listReportedTasks: async () => ({
          // The 20 listed say the key is wrong; one older report gives another reason.
          tasks: [
            {
              ...reportedGreeting,
              reportCount: 21,
              reasonCount: 2,
              reports: Array.from({ length: 20 }, (_, index) =>
                report(`k${index}`, "key-wrong", { choice: 1 }),
              ),
            },
          ],
          more: false,
        }),
      },
    });

    const section = await screen.findByRole("region", { name: "Reported by learners" });
    expect(
      within(section).getByRole("link", {
        name: "Hello, in Spanish?",
        description: "21 learners · The expected answer seems wrong · +1 more reason",
      }),
    ).toBeTruthy();
  });

  test("says a correction waits, under the reports it will close", async () => {
    coursePage({
      listReportedTasks: async () => ({
        tasks: [{ ...reportedGreeting, pendingCorrectionId: "t9" }],
        more: false,
      }),
    });

    fireEvent.click(await screen.findByText("Reported by 2 learners"));
    expect(
      screen.getByText("A correction waits to be published; these reports close when it is."),
    ).toBeTruthy();
  });

  test("leaves the page whole when the reports cannot be read, offering to try again", async () => {
    let fail = true;
    coursePage({
      listReportedTasks: async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return { tasks: [reportedGreeting], more: false };
      },
    });

    expect(await screen.findByText("Reports could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Reported by 2 learners")).toBeTruthy();
    expect(screen.queryByText("Reports could not be loaded.")).toBeNull();
  });

  /** The greeting task, reported `count` times, `shown` of them listed, IDs starting `prefix`. */
  const greetingReports = (count: number, shown: number, prefix = "r"): ReportedTask => ({
    ...reportedGreeting,
    reportCount: count,
    reasonCount: 1,
    reports: Array.from({ length: shown }, (_, index) =>
      report(`${prefix}${index}`, "confusing", { choice: 1 }),
    ),
  });

  test("shows every report read on request, though more arrived meanwhile, until the page reads them again", async () => {
    let page = greetingReports(21, 20);
    const listReportedTasks = vi.fn<BraivoClient["listReportedTasks"]>(async (input) => ({
      // One more arrived after the page read 21.
      tasks: [input.taskId ? greetingReports(22, 22) : page],
      more: false,
    }));
    const { router } = coursePage({ listReportedTasks });

    fireEvent.click(await screen.findByText("Reported by 21 learners"));
    fireEvent.click(screen.getByRole("button", { name: "Show all 21 reports" }));
    expect(await screen.findByText("Reported by 22 learners")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss reports" })).toBeTruthy();

    // Read again, as many but others: the page's read wins over the older whole list.
    page = greetingReports(22, 20, "n");
    await router.invalidate();
    expect(await screen.findByRole("button", { name: "Dismiss these 20" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all 22 reports" })).toBeTruthy();
  });

  // A thousand reports rendered and queried by role: slow in happy-dom on a busy machine.
  test("says when a task has more reports than one read lists, rather than offering them again", async () => {
    const dismissReports = vi.fn<BraivoClient["dismissReports"]>(async () => {});
    coursePage({
      listReportedTasks: async (input: { taskId?: string }) => ({
        tasks: [input.taskId ? greetingReports(1001, 1000) : greetingReports(1001, 20)],
        more: false,
      }),
      dismissReports,
    });

    fireEvent.click(await screen.findByText("Reported by 1001 learners"));
    const showAll = screen.getByRole("button", { name: "Show all 1001 reports" });
    showAll.focus();
    fireEvent.click(showAll);
    expect(
      await screen.findByText("Showing the newest 1,000; dismiss them to see the rest."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    // Its button gone, the focus goes on to Dismiss.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss these 1000" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss these 1000" }));
    await waitFor(() => expect(dismissReports).toHaveBeenCalled());
    expect(dismissReports.mock.calls[0]![0].reportIds).toHaveLength(1000);
  }, 30_000);

  test("never shows one organization's reported tasks on another's page while it reads its own", async () => {
    const { router } = renderAt("/example", {
      organizations: [school, annex],
      braivo: {
        listCourses: async () => [],
        listReportedTasks: (
          input: { organizationId: string },
          options?: { signal?: AbortSignal },
        ) =>
          input.organizationId === school.id
            ? Promise.resolve({ tasks: [reportedGreeting], more: false })
            : stall(options),
      },
    });
    expect(await screen.findByRole("region", { name: "Reported by learners" })).toBeTruthy();

    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "annex" } });
    await waitFor(() => expect(router.state.location.pathname).toBe("/annex"));
    expect(screen.queryByRole("region", { name: "Reported by learners" })).toBeNull();
  });
});
