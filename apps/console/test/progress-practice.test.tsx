// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { CourseProgressOverview, LearnerProgressReport } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { renderAt } from "./render.tsx";

// The course overview's and report's practice in the last seven days
// (progress-17), counted in the reader's own time zone: the runtime's, set here.

/** The reader's time zone from here on in this test. */
function readerIn(timeZone: string) {
  vi.stubEnv("TZ", timeZone);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

beforeEach(() => readerIn("UTC"));

const beginners = { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" };
const listCourses = async () => [beginners];
const standings = { unseen: 1, acquiring: 0, retained: 1, due: 0 };
const AS_OF = "2026-06-01T12:05:00.000Z";

const learner = (userId: string, name: string, lastPractisedAt: string | null) => ({
  userId,
  name,
  roles: ["member"],
  standings,
  repeatedMisses: 0,
  lastPractisedAt,
});

/**
 * Ana practised today, Fay yesterday, Ben three days ago, Cleo twelve; Dan
 * never, nor Eve, whose standings come from results recorded elsewhere.
 */
function practiceOverview(): CourseProgressOverview {
  return {
    open: true,
    modelVersion: "v1",
    asOf: AS_OF,
    repeatedMissesThreshold: 3,
    learners: [
      learner("u1", "Ana", "2026-06-01T08:00:00.000Z"),
      learner("u2", "Ben", "2026-05-29T09:00:00.000Z"),
      learner("u3", "Cleo", "2026-05-20T09:00:00.000Z"),
      learner("u4", "Dan", null),
      learner("u5", "Eve", null),
      learner("u6", "Fay", "2026-05-31T23:30:00.000Z"),
    ],
    objectives: [
      {
        objectiveId: "greetings",
        title: "Greetings",
        standings: { unseen: 6, acquiring: 0, retained: 0, due: 0 },
        repeatedMisses: [],
      },
      {
        objectiveId: "numbers",
        title: "Numbers",
        standings: { unseen: 0, acquiring: 0, retained: 6, due: 0 },
        repeatedMisses: [],
      },
    ],
  };
}

const report = (lastPractisedAt: string | null): LearnerProgressReport => ({
  modelVersion: "v1",
  asOf: AS_OF,
  repeatedMissesThreshold: 3,
  lastPractisedAt,
  objectives: [{ objectiveId: "greetings", title: "Greetings", phase: "unseen", evidence: [] }],
});

/** Each learner row: its header's name, and the text under it. */
function learnerRows() {
  const table = screen.getByRole("table", { name: "Learners" });
  return within(table)
    .getAllByRole("rowheader")
    .map((header) => [
      within(header).getByRole("link").textContent,
      header.querySelector("time")?.textContent ?? header.lastElementChild?.textContent,
    ]);
}

const chip = (name: RegExp) => screen.getByRole("button", { name });

/** A moment as the console shows it in full, in UTC, the answers' zone here. */
const exactTime = (at: string) =>
  new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

describe("practice on the course overview", () => {
  test("counts who practised in the last 7 days over everyone, whatever is searched", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: async () => practiceOverview() },
    });

    const group = await screen.findByRole("group", { name: "Practice in the last 7 days" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
    ).toEqual([
      ["Practised: 3", "false"],
      ["Not lately: 1", "false"],
      ["No practice yet: 2", "false"],
    ]);
    // What the counts mean, said once, in the reader's zone.
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(group.getAttribute("aria-describedby")!)!.textContent).toMatch(
      /^Today and the 6 days before, in your time zone \(UTC\)/,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a learner" }), {
      target: { value: "nobody" },
    });
    expect(await screen.findByText("No learner matches “nobody”.")).toBeTruthy();
    // A count never drops to what the search shows.
    expect(chip(/^Practised: 3$/)).toBeTruthy();
    expect(chip(/^No practice yet: 2$/)).toBeTruthy();
  });

  test("filters the learners to a count, kept through a report and back, pressed again to show all", async () => {
    const { router } = renderAt("/example/courses/course-1/progress?sort=due", {
      braivo: {
        listCourses,
        courseProgress: async () => practiceOverview(),
        listMembers: async () => practiceOverview().learners,
        learnerProgress: async () => report(null),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "No practice yet: 2" }));
    await vi.waitFor(() =>
      expect(router.state.location.search).toEqual({ sort: "due", practice: "none" }),
    );
    await vi.waitFor(() =>
      expect(chip(/^No practice yet/).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(learnerRows().map(([name]) => name)).toEqual(["Dan", "Eve"]);
    // The objectives still count everyone, and say so.
    expect(screen.getByText(/whatever the search or filter above/)).toBeTruthy();
    expect(
      within(screen.getByRole("table", { name: "Progress by objective" })).getAllByRole("row"),
    ).toHaveLength(3);

    // Searched within the filter, then to a report and back.
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a learner" }), {
      target: { value: "e" },
    });
    await vi.waitFor(() => expect(learnerRows().map(([name]) => name)).toEqual(["Eve"]));
    fireEvent.click(screen.getByRole("link", { name: "Eve" }));
    await screen.findByRole("heading", { level: 1, name: "Eve" });
    expect(router.state.location.search).toEqual({ sort: "due", practice: "none", q: "e" });
    fireEvent.click(screen.getByRole("link", { name: "Beginners" }));
    await screen.findByRole("table", { name: "Learners" });
    expect(learnerRows().map(([name]) => name)).toEqual(["Eve"]);
    expect(chip(/^No practice yet/).getAttribute("aria-pressed")).toBe("true");

    // Another count replaces it; pressing it again shows everyone.
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a learner" }), {
      target: { value: "" },
    });
    fireEvent.click(chip(/^Practised/));
    await vi.waitFor(() =>
      expect(learnerRows().map(([name]) => name)).toEqual(["Ana", "Ben", "Fay"]),
    );
    expect(chip(/^No practice yet/).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip(/^Practised/));
    await vi.waitFor(() => expect(learnerRows()).toHaveLength(6));
    expect(router.state.location.search).toEqual({ sort: "due" });
  });

  test("says when none matches the search and filter, naming the filter too", async () => {
    // Ana practised today: hidden by the filter, not missing from the roster.
    renderAt("/example/courses/course-1/progress?practice=earlier&q=Ana", {
      braivo: { listCourses, courseProgress: async () => practiceOverview() },
    });
    expect(
      await screen.findByText("No learner matches “Ana” with this practice filter."),
    ).toBeTruthy();
    fireEvent.click(chip(/^Not lately/));
    expect(await screen.findByRole("rowheader", { name: "Ana" })).toBeTruthy();
  });

  test("says which members are staff, outside the row's name, where roles are given", async () => {
    // An administrator's view: an owner who never practises counts among the learners.
    const withOwner = (roles?: string[]) => async () => ({
      ...practiceOverview(),
      learners: [learner("u1", "Ana", null), { ...learner("u8", "Olive", null), roles }],
    });
    for (const [roles, text] of [
      [["owner", "admin"], "Owner and Admin · No practice recorded yet"],
      // A teacher's view carries no roles (access-26).
      [undefined, "No practice recorded yet"],
    ] as const) {
      renderAt("/example/courses/course-1/progress", {
        braivo: { listCourses, courseProgress: withOwner(roles && [...roles]) },
      });
      const table = await screen.findByRole("table", { name: "Learners" });
      const ana = within(table).getByRole("rowheader", { name: "Ana" });
      const olive = within(table).getByRole("rowheader", { name: "Olive" });
      expect(ana.lastElementChild!.textContent).toBe("No practice recorded yet");
      expect(olive.lastElementChild!.textContent).toBe(text);
      expect(chip(/^No practice yet/).textContent).toBe("No practice yet: 2");
      cleanup();
    }
  });

  test("says under each name when they last practised, outside the row's name", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: async () => practiceOverview() },
    });

    await screen.findByRole("table", { name: "Learners" });
    expect(learnerRows()).toEqual([
      ["Ana", "Last practised today"],
      ["Ben", "Last practised 3 days ago"],
      // Beyond the window, its date.
      ["Cleo", "Last practised May 20"],
      ["Dan", "No practice recorded yet"],
      ["Eve", "No practice recorded yet"],
      ["Fay", "Last practised yesterday"],
    ]);
    const table = screen.getByRole("table", { name: "Learners" });
    // Moving across a row announces the learner, not their practice, which describes them.
    const ben = within(table).getByRole("rowheader", {
      name: "Ben",
      description: "Last practised 3 days ago",
    });
    expect(ben.querySelector("time")!.getAttribute("dateTime")).toBe("2026-05-29T09:00:00.000Z");
    expect(ben.querySelector("time")!.getAttribute("title")).toBe(
      exactTime("2026-05-29T09:00:00.000Z"),
    );
  });

  test("counts and dates by the reader's calendar, whose midnight decides the window", async () => {
    // As of 14:05 on June 1 in Warsaw, 02:05 on June 2 in Auckland. Gil's last
    // answer, 12:59:59 on May 26 in Warsaw, is 22:59:59 that day in Auckland: in
    // Warsaw's window, from May 26; a date before Auckland's, from May 27.
    const gil = learner("u7", "Gil", "2026-05-26T10:59:59.000Z");
    const progress = async () => ({ ...practiceOverview(), learners: [gil] });
    for (const [timeZone, text, counts] of [
      ["Europe/Warsaw", "Last practised 6 days ago", ["Practised: 1", "Not lately: 0"]],
      ["Pacific/Auckland", "Last practised May 26", ["Practised: 0", "Not lately: 1"]],
    ] as const) {
      readerIn(timeZone);
      renderAt("/example/courses/course-1/progress", {
        braivo: { listCourses, courseProgress: progress },
      });

      await screen.findByRole("table", { name: "Learners" });
      expect(learnerRows()).toEqual([["Gil", text]]);
      for (const name of counts) expect(screen.getByRole("button", { name })).toBeTruthy();
      expect(screen.getByText(new RegExp(`in your time zone \\(${timeZone}\\)`))).toBeTruthy();
      cleanup();
    }
  });

  test("dates practice in another year than today's with its year", async () => {
    const hal = learner("u8", "Hal", "2025-12-20T09:00:00.000Z");
    renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses,
        courseProgress: async () => ({
          ...practiceOverview(),
          asOf: "2026-01-03T12:00:00.000Z",
          learners: [hal],
        }),
      },
    });

    await screen.findByRole("table", { name: "Learners" });
    expect(learnerRows()).toEqual([["Hal", "Last practised Dec 20, 2025"]]);
  });

  test("hides the practice counts, and ignores a practice filter, in a course without objectives", async () => {
    renderAt("/example/courses/course-1/progress?practice=recent", {
      braivo: {
        listCourses,
        courseProgress: async () => ({
          ...practiceOverview(),
          objectives: [],
        }),
      },
    });

    await screen.findByRole("table", { name: "Learners" });
    expect(screen.queryByRole("group", { name: "Practice in the last 7 days" })).toBeNull();
    // A filter left in the URL hides no one: there is no toggle to clear it.
    expect(learnerRows()).toHaveLength(6);
  });
});

describe("practice in a learner's report", () => {
  test("says when they last practised, with its date and time", async () => {
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: {
        listCourses,
        listMembers: async () => practiceOverview().learners,
        learnerProgress: async () => report("2026-05-29T09:00:00.000Z"),
      },
    });

    expect(await screen.findByText("Last practised 3 days ago", { selector: "time" })).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent ===
          `Last practised 3 days ago (${exactTime("2026-05-29T09:00:00.000Z")})`,
        { selector: "span" },
      ),
    ).toBeTruthy();
  });

  test("says when they have not practised, and why a result recorded elsewhere is not practice", async () => {
    // Eve: standings from a result recorded elsewhere, no question answered here.
    renderAt("/example/courses/course-1/learners/u5", {
      braivo: {
        listCourses,
        listMembers: async () => practiceOverview().learners,
        learnerProgress: async () => ({
          ...report(null),
          objectives: [
            {
              objectiveId: "greetings",
              title: "Greetings",
              phase: "retaining",
              lastEvidenceAt: "2026-05-31T09:00:00.000Z",
              stability: 4,
              retrievability: 0.9,
              due: false,
              dueAt: "2026-06-04T09:00:00.000Z",
              evidence: [{ outcome: "success", at: "2026-05-31T09:00:00.000Z" }],
            },
          ],
        }),
      },
    });

    expect(
      await screen.findByText("No practice recorded yet on this course's objectives"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Last practised counts questions answered here, Show answer included. Results recorded elsewhere count toward standings, not practice.",
      ),
    ).toBeTruthy();
  });

  test("dates practice before the window by its date and time", async () => {
    renderAt("/example/courses/course-1/learners/u3", {
      braivo: {
        listCourses,
        listMembers: async () => practiceOverview().learners,
        learnerProgress: async () => report("2026-05-20T09:00:00.000Z"),
      },
    });

    expect(
      await screen.findByText(`Last practised ${exactTime("2026-05-20T09:00:00.000Z")}`),
    ).toBeTruthy();
  });
});
