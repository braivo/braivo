// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type CourseProgressOverview, type Organization } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { courseProgress, members, school } from "./fixtures.ts";
import { renderAt, stall } from "./render.tsx";

// The course overview's repeated misses (progress-16), its "As of", and Refresh.

const beginners = { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" };
const listCourses = async () => [beginners];
// Every learner still learning all three objectives, so the two tables tally (progress-13).
const learnerStandings = { unseen: 0, acquiring: 3, retained: 0, due: 0 };
const objectiveStandings = { unseen: 0, acquiring: 5, retained: 0, due: 0 };
const may = (day: number) => `2026-05-${day}T09:00:00.000Z`;

/**
 * Lee with two objectives of repeated misses; two learners named Ana, the one
 * ending 111111 with one; Ben with one, fresher than hers; Olive with none.
 * Each learner's count is as many lists as name them.
 */
function flagged(asOf = "2026-06-01T12:05:00.000Z"): CourseProgressOverview {
  return {
    open: true,
    modelVersion: "v1",
    asOf,
    repeatedMissesThreshold: 3,
    learners: [
      {
        userId: "x-111111",
        name: "Ana",
        standings: learnerStandings,
        repeatedMisses: 1,
        lastPractisedAt: null,
      },
      {
        userId: "y-222222",
        name: "Ana",
        standings: learnerStandings,
        repeatedMisses: 0,
        lastPractisedAt: null,
      },
      {
        userId: "u5",
        name: "Ben",
        standings: learnerStandings,
        repeatedMisses: 1,
        lastPractisedAt: null,
      },
      { ...members[1]!, standings: learnerStandings, repeatedMisses: 2, lastPractisedAt: null },
      { ...members[0]!, standings: learnerStandings, repeatedMisses: 0, lastPractisedAt: null },
    ],
    objectives: [
      {
        objectiveId: "greetings",
        title: "Greetings",
        standings: objectiveStandings,
        repeatedMisses: [
          {
            userId: "u2",
            name: "Lee Learner",
            misses: { count: 5, lastMissAt: may(30), everSucceeded: true },
          },
          {
            userId: "x-111111",
            name: "Ana",
            misses: { count: 3, lastMissAt: may(29), everSucceeded: false },
          },
        ],
      },
      {
        objectiveId: "numbers",
        title: "Numbers",
        standings: objectiveStandings,
        repeatedMisses: [
          {
            userId: "u5",
            name: "Ben",
            misses: { count: 4, lastMissAt: may(31), everSucceeded: true },
          },
          {
            userId: "u2",
            name: "Lee Learner",
            misses: { count: 3, lastMissAt: may(28), everSucceeded: false },
          },
        ],
      },
      {
        objectiveId: "colours",
        title: "Colours",
        standings: objectiveStandings,
        repeatedMisses: [],
      },
    ],
  };
}

/** Ben missed Greetings three times since, as both tables count. */
function withBenOnGreetings(progress: CourseProgressOverview): CourseProgressOverview {
  const ben = {
    userId: "u5",
    name: "Ben",
    misses: { count: 3, lastMissAt: may(31), everSucceeded: true },
  };
  return {
    ...progress,
    learners: progress.learners.map((learner) =>
      learner.userId === "u5" ? { ...learner, repeatedMisses: 2 } : learner,
    ),
    objectives: progress.objectives.map((objective) =>
      objective.objectiveId === "greetings"
        ? // As the server orders them: Ben's three, fresher than Ana's, before hers.
          { ...objective, repeatedMisses: objective.repeatedMisses.toSpliced(1, 0, ben) }
        : objective,
    ),
  };
}

const dated = (at: string) => new Date(at).toLocaleDateString("en", { dateStyle: "medium" });
const moment = (at: string) =>
  new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

/** Each learner row's link name and repeated misses, in the order shown. */
function learnerRows() {
  const table = screen.getByRole("table", { name: "Learners" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => [
      within(within(row).getByRole("rowheader")).getByRole("link").textContent,
      within(row).getAllByRole("cell")[2]!.textContent,
    ]);
}

const toggle = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`with repeated misses on ${title}$`) });

describe("repeated misses on the course overview", () => {
  test("counts each learner's objectives with repeated misses, explained in words, not a tooltip", async () => {
    renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: async () => flagged() },
    });

    expect(await screen.findByRole("table", { name: "Learners" })).toBeTruthy();
    expect(learnerRows()).toEqual([
      ["Ana111111", "1"],
      ["Ana222222", ""],
      ["Ben", "1"],
      ["Lee Learner", "2"],
      ["Olive Owner", ""],
    ]);
    // The column's heading, in both tables, is described by the line saying what it counts.
    for (const name of ["Learners", "Progress by objective"]) {
      const heading = within(screen.getByRole("table", { name })).getByRole("columnheader", {
        name: "Repeated misses",
      });
      const description = document.getElementById(heading.getAttribute("aria-describedby")!)!;
      expect(description.textContent).toBe(
        "Repeated misses: objectives still being learned with 3 or more misses since the last correct answer. Show answer counts as a miss.",
      );
    }
    expect(screen.queryByText("No objectives currently have repeated misses.")).toBeNull();
  });

  test("orders the most repeated misses first, equal counts the fresher, and keeps it through a report and back", async () => {
    const { router } = renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses,
        courseProgress: async () => flagged(),
        learnerProgress: async () => ({
          modelVersion: "v1",
          asOf: "2026-06-01T12:05:00.000Z",
          repeatedMissesThreshold: 3,
          lastPractisedAt: null,
          objectives: [],
        }),
      },
    });

    fireEvent.change(await screen.findByLabelText("Order"), { target: { value: "misses" } });
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ sort: "misses" }));
    // Ben's latest miss, May 31, is fresher than Ana's, May 29: not by name.
    await vi.waitFor(() => expect(learnerRows()[0]).toEqual(["Lee Learner", "2"]));
    expect(learnerRows()).toEqual([
      ["Lee Learner", "2"],
      ["Ben", "1"],
      ["Ana111111", "1"],
      ["Ana222222", ""],
      ["Olive Owner", ""],
    ]);

    fireEvent.click(
      within(screen.getByRole("table", { name: "Learners" })).getByRole("link", {
        name: "Lee Learner",
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Lee Learner" });
    fireEvent.click(screen.getByRole("link", { name: "Beginners" }));
    await screen.findByRole("table", { name: "Learners" });
    expect(router.state.location.search).toEqual({ sort: "misses" });
    expect(learnerRows()[0]).toEqual(["Lee Learner", "2"]);
  });

  test("opens an objective's count into its learners, linked to the objective in their report", async () => {
    renderAt("/example/courses/course-1/progress?sort=misses&q=a", {
      braivo: { listCourses, courseProgress: async () => flagged() },
    });

    const table = await screen.findByRole("table", { name: "Progress by objective" });
    const greetings = toggle("Greetings");
    expect(greetings.getAttribute("aria-label")).toBe(
      "2 learners with repeated misses on Greetings",
    );
    expect(greetings.textContent).toBe("2 learners");
    expect(greetings.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: /on Greetings$/ })).toBeNull();
    // Naming no element that is absent.
    expect(greetings.hasAttribute("aria-controls")).toBe(false);
    // None for an objective without any.
    const colours = within(table).getByRole("rowheader", { name: "Colours" }).closest("tr")!;
    expect(within(colours).queryByRole("button")).toBeNull();

    fireEvent.click(greetings);
    fireEvent.click(toggle("Numbers"));

    expect(greetings.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", {
      name: "2 learners with repeated misses on Greetings",
    });
    expect(greetings.getAttribute("aria-controls")).toBe(list.id);
    // In a row of its own below, so the objective's row header is still its title alone.
    expect(within(table).getByRole("rowheader", { name: "Greetings" })).toBeTruthy();
    expect(list.closest("tr")).not.toBe(greetings.closest("tr"));
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `Lee Learner5 misses since the last correct answer, latest ${dated(may(30))}`,
      `Ana1111113 misses, no correct answer yet, latest ${dated(may(29))}`,
    ]);
    // To the objective in their report, keeping the page's search and order for Back.
    const lee = within(list).getByRole("link", { name: "Lee Learner" });
    expect(lee.getAttribute("href")).toBe(
      "/example/courses/course-1/learners/u2?q=a&sort=misses#objective-greetings",
    );
    // A namesake carries the same tag as in their learner row, in what is seen and heard.
    const ana = within(list).getByRole("link", { name: /^Ana/ });
    const row = within(screen.getByRole("table", { name: "Learners" })).getByRole("link", {
      name: /^Ana.*111111$/,
    });
    expect(ana.textContent).toBe(row.textContent);
    expect(ana.textContent).toBe("Ana111111");
    expect(ana.getAttribute("href")).toBe(
      "/example/courses/course-1/learners/x-111111?q=a&sort=misses#objective-greetings",
    );
    // Several open at once, Ben's first: most misses.
    expect(
      within(screen.getByRole("list", { name: "2 learners with repeated misses on Numbers" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Ben", "Lee Learner"]);

    fireEvent.click(greetings);
    expect(greetings.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: /on Greetings$/ })).toBeNull();
  });

  test("counts objectives' repeated misses over every learner, whoever is searched for", async () => {
    renderAt("/example/courses/course-1/progress?q=Ben", {
      braivo: { listCourses, courseProgress: async () => flagged() },
    });

    await screen.findByRole("table", { name: "Learners" });
    expect(learnerRows()).toEqual([["Ben", "1"]]);
    fireEvent.click(toggle("Greetings"));
    expect(
      within(screen.getByRole("list", { name: "2 learners with repeated misses on Greetings" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Lee Learner", "Ana111111"]);

    // Typed, ahead of the URL: its links carry it, as the learners' rows do.
    fireEvent.change(screen.getByLabelText("Find a learner"), { target: { value: "Lee" } });
    const lee = within(
      screen.getByRole("list", { name: "2 learners with repeated misses on Greetings" }),
    ).getByRole("link", { name: "Lee Learner" });
    expect(lee.getAttribute("href")).toBe(
      "/example/courses/course-1/learners/u2?q=Lee#objective-greetings",
    );
  });

  test("says when no learner has repeated misses, and no more", async () => {
    renderAt("/example/courses/course-1/progress", { braivo: { listCourses } });

    expect(await screen.findByText("No objectives currently have repeated misses.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with repeated misses/ })).toBeNull();
  });
});

describe("refreshing the course overview", () => {
  test("reads it again in place, keeping what is searched, sorted, and open, and says as of when", async () => {
    const progress = vi
      .fn<() => Promise<CourseProgressOverview>>()
      .mockResolvedValueOnce(flagged())
      .mockResolvedValueOnce(withBenOnGreetings(flagged("2026-06-01T12:40:00.000Z")));
    const courses = vi.fn(listCourses);
    const { router } = renderAt("/example/courses/course-1/progress?sort=misses&q=Be", {
      braivo: { listCourses: courses, courseProgress: progress },
    });

    expect(await screen.findByText(`As of ${moment("2026-06-01T12:05:00.000Z")}`)).toBeTruthy();
    fireEvent.click(toggle("Greetings"));
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    fireEvent.click(refresh);

    expect(await screen.findByText(`As of ${moment("2026-06-01T12:40:00.000Z")}`)).toBeTruthy();
    // Read again whole: the course, then its progress.
    expect([courses.mock.calls.length, progress.mock.calls.length]).toEqual([2, 2]);
    expect(learnerRows()).toEqual([["Ben", "2"]]);
    expect(router.state.location.search).toEqual({ sort: "misses", q: "Be" });
    expect((screen.getByLabelText("Find a learner") as HTMLInputElement).value).toBe("Be");
    expect(toggle("Greetings").getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "3 learners with repeated misses on Greetings" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Lee Learner", "Ben", "Ana111111"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh" }));
  });

  test("closes an objective whose learners a Refresh cleared, leaving no empty row", async () => {
    const cleared = flagged("2026-06-01T12:40:00.000Z");
    const progress = vi
      .fn<() => Promise<CourseProgressOverview>>()
      .mockResolvedValueOnce(flagged())
      .mockResolvedValueOnce({
        ...cleared,
        // Lee and Ana answered Greetings correctly since, retaining it now.
        learners: cleared.learners.map((learner) =>
          learner.userId === "u2" || learner.userId === "x-111111"
            ? {
                ...learner,
                standings: { unseen: 0, acquiring: 2, retained: 1, due: 0 },
                repeatedMisses: learner.repeatedMisses - 1,
              }
            : learner,
        ),
        objectives: cleared.objectives.map((objective) =>
          objective.objectiveId === "greetings"
            ? {
                ...objective,
                standings: { unseen: 0, acquiring: 3, retained: 2, due: 0 },
                repeatedMisses: [],
              }
            : objective,
        ),
      });
    renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: progress },
    });

    fireEvent.click(await screen.findByRole("button", { name: /on Greetings$/ }));
    const rows = within(screen.getByRole("table", { name: "Progress by objective" })).getAllByRole(
      "row",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(`As of ${moment("2026-06-01T12:40:00.000Z")}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /on Greetings$/ })).toBeNull();
    expect(screen.queryByRole("list", { name: /on Greetings$/ })).toBeNull();
    expect(
      within(screen.getByRole("table", { name: "Progress by objective" })).getAllByRole("row"),
    ).toHaveLength(rows - 1);
  });

  test("keeps the page and its moment when a Refresh fails, saying so each time", async () => {
    let answer: () => Promise<CourseProgressOverview> = async () => flagged();
    const { router } = renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: () => answer() },
    });

    expect(await screen.findByText(`As of ${moment("2026-06-01T12:05:00.000Z")}`)).toBeTruthy();
    let release!: () => void;
    answer = () =>
      new Promise((_resolve, reject) => {
        release = () => reject(new BraivoError(500, "Braivo answered 500."));
      });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    fireEvent.click(refresh);

    // Pending: said, locked, still focused, the tables kept.
    const pending = await screen.findByRole("button", { name: "Refreshing…" });
    expect(pending).toBe(refresh);
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(pending);
    expect(screen.getByRole("table", { name: "Learners" })).toBeTruthy();
    release();

    const first = await screen.findByRole("alert");
    expect(first.textContent).toBe("Could not refresh. Try again.");
    expect(screen.getByText(`As of ${moment("2026-06-01T12:05:00.000Z")}`)).toBeTruthy();
    expect(learnerRows()).toHaveLength(5);

    answer = async () => Promise.reject(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    // A new alert, so it is announced again.
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));
    expect(screen.getByRole("alert").textContent).toBe("Could not refresh. Try again.");

    // Read again by the router, the page is new, and so is what failed to replace it.
    answer = async () => flagged("2026-06-01T12:40:00.000Z");
    await router.invalidate();
    expect(await screen.findByText(`As of ${moment("2026-06-01T12:40:00.000Z")}`)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows not found when Braivo refuses the course on Refresh, never the old roster", async () => {
    let answer: () => Promise<CourseProgressOverview> = async () => flagged();
    renderAt("/example/courses/course-1/progress", {
      braivo: { listCourses, courseProgress: () => answer() },
    });

    await screen.findByRole("table", { name: "Learners" });
    answer = async () => Promise.reject(new BraivoError(404, "Braivo answered 404."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    // Said, as it replaces the focused button.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This course does not exist, or its progress is not yours to see.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Lee Learner")).toBeNull();
  });

  test("goes to sign in when the session ended before a Refresh", async () => {
    let signedIn = true;
    const { router } = renderAt("/example/courses/course-1/progress", {
      getSession: async () => ({
        data: signedIn ? { user: { id: "u1", name: "Olive Owner", email: "o@example.com" } } : null,
        error: null,
      }),
      braivo: {
        listCourses,
        courseProgress: async () => {
          if (signedIn) return flagged();
          throw new BraivoError(401, "Braivo answered 401.");
        },
      },
    });

    await screen.findByRole("table", { name: "Learners" });
    signedIn = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  test("names a teacher's groups as they are now, with the roster read with them", async () => {
    const taught: Organization = { ...school, administers: false, authors: false, teaches: true };
    const group = (id: string, name: string) => ({
      id,
      organizationId: "org-1",
      name,
      teachers: [{ userId: "u1", name: "Olive Owner" }],
      learners: [{ userId: "u2", name: "Lee Learner" }],
      courses: [beginners],
    });
    const listGroups = vi
      .fn()
      .mockResolvedValueOnce([group("g1", "7A"), group("g2", "7B")])
      .mockResolvedValueOnce([group("g1", "7A")]);
    renderAt("/example/courses/course-1/progress", {
      organizations: [taught],
      braivo: {
        listGroups,
        courseProgress: async () => {
          const progress = await courseProgress();
          return { ...progress, learners: [{ ...progress.learners[0]!, roles: undefined }] };
        },
      },
    });

    expect(await screen.findByText(/across your groups: 7A and 7B\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/across your groups: 7A\./)).toBeTruthy();
  });

  test("leaves a Refresh behind when another course's page opens, which it never overwrites", async () => {
    const signals: AbortSignal[] = [];
    const courses = async () => [beginners, { ...beginners, id: "course-2", title: "Advanced" }];
    let refreshing = false;
    const { router } = renderAt("/example/courses/course-1/progress", {
      braivo: {
        listCourses: courses,
        courseProgress: (courseId: string, options?: { signal?: AbortSignal }) => {
          if (refreshing && courseId === "course-1") {
            signals.push(options!.signal!);
            return stall(options);
          }
          return Promise.resolve(courseId === "course-1" ? flagged() : courseProgress());
        },
      },
    });

    await screen.findByRole("heading", { name: "Beginners" });
    refreshing = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await router.navigate({
      to: "/$organizationSlug/courses/$courseId/progress",
      params: { organizationSlug: "example", courseId: "course-2" },
    });

    expect(await screen.findByRole("heading", { name: "Advanced" })).toBeTruthy();
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No objectives currently have repeated misses.")).toBeTruthy();
  });
});
