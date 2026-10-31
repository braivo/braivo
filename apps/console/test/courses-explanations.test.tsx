// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

// A course's page and an objective's saying which tasks explain nothing after
// grading, and the course's narrowed to them, Publish acting on what it shows.

import { activateLocale } from "@braivo/i18n";
import type { AuthoredCourse, BraivoClient } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { beginners, school } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

type Task = AuthoredCourse["objectives"][number]["tasks"][number];

const cited = [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }];

/** A choice task, published unless said, explained only when given one. */
function task(
  id: string,
  prompt: string,
  options: { explanation?: string; published?: boolean; cites?: boolean; replaces?: string } = {},
): Task {
  const { explanation, published = true, cites = false, replaces } = options;
  return {
    id,
    kind: "choice",
    prompt,
    options: ["Sí", "No"],
    answer: 0,
    ...(explanation && { explanation }),
    citations: cites ? cited : [],
    published,
    ...(replaces && { replaces }),
  };
}

/** `beginners` with Greetings, Numbers, and a third objective, Colours, practised by these. */
function course(
  greetings: Task[],
  numbers: Task[],
  colours: Task[] = [],
  published = true,
): AuthoredCourse {
  const [first, second] = beginners.objectives;
  return {
    ...beginners,
    published,
    objectives: [
      { ...first!, tasks: greetings },
      { ...second!, tasks: numbers },
      { id: "colours", title: "Colours", citations: [], tasks: colours, otherPublishedCourses: [] },
    ],
  };
}

// Published: one explained, one citing a passage but explaining nothing, one bare.
const explained = task("t-explained", "Explained?", { explanation: "Because.", cites: true });
const unexplainedCited = task("t-cited", "Cited?", { cites: true });
const bare = task("t-bare", "Bare?");
// Pending: one without, one with.
const waiting = task("t-waiting", "Waiting?", { published: false });
const waitingExplained = task("t-waiting-explained", "Waiting, explained?", {
  published: false,
  explanation: "Yes.",
});

const renderCourse = (path = "", braivo: object = {}) =>
  renderAt(`/example/courses/course-1${path}`, { braivo });

describe("tasks without an explanation", () => {
  test("counts them on the course's page, published and pending apart, and marks each in words", async () => {
    renderCourse("", {
      readCourse: async () =>
        course([explained, unexplainedCited, waiting], [bare, waitingExplained]),
    });

    expect(
      await screen.findByText(
        "2 of 3 published tasks have no explanation; 1 also cites no passage. 1 task waiting for review has no explanation.",
      ),
    ).toBeTruthy();
    const marked = screen.getAllByText("No explanation");
    expect(marked).toHaveLength(3);
    const teaches = screen.getByRole("region", { name: "What it teaches" });
    for (const prompt of ["Cited?", "Bare?"]) {
      const card = within(teaches).getByText(prompt).closest("[data-slot=card]") as HTMLElement;
      expect(within(card).getByText("No explanation"), prompt).toBeTruthy();
    }
    const explainedCard = within(teaches)
      .getByText("Explained?")
      .closest("[data-slot=card]") as HTMLElement;
    expect(within(explainedCard).queryByText("No explanation")).toBeNull();
  });

  test("names what is missing when only tasks waiting for review lack it", async () => {
    renderCourse("", { readCourse: async () => course([explained, waiting], [waitingExplained]) });

    expect(await screen.findByText("1 task waiting for review has no explanation.")).toBeTruthy();
  });

  test("says nothing, and offers no filter, when every task has one", async () => {
    renderCourse("", { readCourse: async () => course([explained], [waitingExplained]) });

    await screen.findByRole("region", { name: "What it teaches" });
    expect(screen.queryByText(/no explanation/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show only these" })).toBeNull();
  });

  test("narrows both sections to them, keeping a gap's pending correction beside it, then shows all again", async () => {
    // A published gap with an explained correction waiting, an explained task
    // with a correction dropping its explanation, and a published gap alone.
    const gap = task("t-gap", "Gap?");
    const fix = task("t-fix", "Gap, fixed?", {
      published: false,
      explanation: "Fixed.",
      replaces: "t-gap",
    });
    const kept = task("t-kept", "Kept?", { explanation: "Kept." });
    const dropping = task("t-dropping", "Kept, dropped?", { published: false, replaces: "t-kept" });
    renderCourse("", {
      readCourse: async () => course([explained, gap, fix, kept, dropping], [bare], [explained]),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Show only these" }));

    const pending = await screen.findByRole("region", { name: "Needs review" });
    const reviewed = within(pending).getByRole("article", { name: "1. Greetings" });
    expect(within(reviewed).getByText("Gap, fixed?")).toBeTruthy();
    expect(within(reviewed).getByText("Kept, dropped?")).toBeTruthy();
    // Each correction with the task it corrects as published now, buttons and all.
    expect(within(reviewed).getAllByText("As published now:")).toHaveLength(2);
    const teaches = screen.getByRole("region", { name: "What it teaches" });
    // The gap whose correction waits is shown only beside it: no Edit of the
    // original, which would retire the correction.
    expect(within(teaches).queryByRole("article", { name: "1. Greetings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit “Gap?”" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit unpublished task “Gap, fixed?”" }),
    ).toBeTruthy();
    // An objective with only a published gap and nothing pending, under What it teaches alone.
    const numbers = within(teaches).getByRole("article", { name: "2. Numbers" });
    expect(within(numbers).getByText("Bare?")).toBeTruthy();
    expect(within(pending).queryByRole("article", { name: "2. Numbers" })).toBeNull();
    // Nothing explained, and no objective without a gap.
    expect(screen.queryByText("Explained?")).toBeNull();
    expect(screen.queryByRole("article", { name: "3. Colours" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(await screen.findAllByText("Explained?")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edit “Gap?”" })).toBeTruthy();
  });

  test("publishes only what it shows while narrowed, and says so", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    renderCourse("?without=explanation", {
      readCourse: async () => course([waiting, waitingExplained], [bare], [explained]),
      publish,
    });

    expect(await screen.findByText("Publish acts only on the tasks shown.")).toBeTruthy();
    expect(screen.queryByText("Waiting, explained?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish all (1)" }));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: school.id, courseIds: [], taskIds: ["t-waiting"] },
        expect.anything(),
      ),
    );
    // Select all selects what is shown.
    expect(screen.getByRole("checkbox", { name: "Select all 1 of “Greetings”" })).toBeTruthy();
  });

  test("keeps Publish for a lone pending correction of a gap, sending it", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const gap = task("t-gap", "Gap?");
    const fix = task("t-fix", "Gap, fixed?", {
      published: false,
      explanation: "Fixed.",
      replaces: "t-gap",
    });
    renderCourse("?without=explanation", {
      readCourse: async () => course([gap, fix], [explained], [explained]),
      publish,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: school.id, courseIds: [], taskIds: ["t-fix"] },
        expect.anything(),
      ),
    );
  });

  test("still asks about an objective left without practice that the filter hides, Review them focusing the title", async () => {
    // Unpublished, its Numbers without any task: Publish warns of it.
    renderCourse("?without=explanation", {
      readCourse: async () => course([explained, waiting], [], [], false),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish with all (1)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(within(dialog).getByRole("list", { name: "Objectives without practice" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Numbers", "Colours"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review them" }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
    );
  });

  test("waits for an open editor before narrowing, so no unsaved edit is lost", async () => {
    renderCourse("", { readCourse: async () => course([explained, bare], []) });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Bare?”" }));
    expect(
      (screen.getByRole("button", { name: "Show only these" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("tasks without an explanation, narrowed", () => {
  test("keeps the focus on the toggle, or gives it to the title once nothing is left to narrow to", async () => {
    renderCourse("", { readCourse: async () => course([bare], [explained], [explained]) });

    const toggle = await screen.findByRole("button", { name: "Show only these" });
    toggle.focus();
    fireEvent.click(toggle);
    await screen.findByRole("button", { name: "Show all" });
    expect(document.activeElement).toBe(toggle);

    cleanup();
    renderCourse("?without=explanation", {
      readCourse: async () => course([explained], [], [explained]),
    });
    expect(await screen.findByText("Every task has an explanation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
    );
  });

  test("leaves out What it teaches with no published task shown, and tells no tasks from every task explained", async () => {
    renderCourse("?without=explanation", {
      readCourse: async () => course([explained], [], [explained]),
    });
    expect(await screen.findByText("Every task has an explanation.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What it teaches" })).toBeNull();

    // Only a pending task without one: Needs review alone.
    cleanup();
    renderCourse("?without=explanation", {
      readCourse: async () => course([explained, waiting], [], [explained]),
    });
    expect(await screen.findByRole("region", { name: "Needs review" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What it teaches" })).toBeNull();

    // Nothing to explain is no completion.
    cleanup();
    renderCourse("?without=explanation", { readCourse: async () => course([], []) });
    expect(await screen.findByText("No tasks yet.")).toBeTruthy();
    expect(screen.queryByText("Every task has an explanation.")).toBeNull();
  });

  test("sends what Select all selects, never a task selected before narrowing that it hides", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const other = task("t-other", "Other?", { published: false });
    renderCourse("", {
      readCourse: async () => course([waiting, waitingExplained], [explained, other], [explained]),
      publish,
    });

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select unpublished task “Waiting, explained?”",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show only these" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all 1 of “Greetings”" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish selected (1)" }));

    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: school.id, courseIds: [], taskIds: ["t-waiting"] },
        expect.anything(),
      ),
    );
  });

  test("sends a gap's unexplained correction with Publish all, shown beside the gap", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const gap = task("t-gap", "Gap?");
    const retry = task("t-retry", "Gap, again?", { published: false, replaces: "t-gap" });
    renderCourse("?without=explanation", {
      readCourse: async () => course([gap, retry], [explained], [explained]),
      publish,
    });

    const pending = await screen.findByRole("region", { name: "Needs review" });
    expect(within(pending).getByText("As published now:")).toBeTruthy();
    expect(within(pending).getAllByText("No explanation")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Publish all (1)" }));
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { organizationId: school.id, courseIds: [], taskIds: ["t-retry"] },
        expect.anything(),
      ),
    );
  });

  test("still asks about the sent tasks' findings and the courses they reach", async () => {
    const flagged: Task = {
      id: "t-flagged",
      kind: "typed",
      prompt: "Say hello.",
      accepted: ["Hello."],
      citations: [],
      published: false,
      findings: [{ code: "typed-trailing-punctuation", answer: "Hello.", suggestion: "Hello" }],
    };
    const shared = course([flagged], [explained], [explained]);
    shared.objectives[0] = {
      ...shared.objectives[0]!,
      otherPublishedCourses: [{ id: "course-2", title: "Travellers" }],
    };
    renderCourse("?without=explanation", { readCourse: async () => shared });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("1 of these tasks has checks to review")).toBeTruthy();
    expect(
      within(within(dialog).getByRole("list", { name: "Courses" })).getByText("Travellers"),
    ).toBeTruthy();
  });

  test("counts them in Polish, agreeing with one published task as with many", async () => {
    onTestFinished(() => activateLocale("en"));
    await activateLocale("pl");
    renderAt("/example/objectives/greetings", {
      braivo: {
        listTasks: async () => [bare, waiting],
        listObjectives: async () => [
          { id: "greetings", title: "Greetings", courseIds: [], pendingTaskCount: 1 },
        ],
        listCourses: async () => [],
        listSources: async () => [],
      },
    });

    expect(
      await screen.findByText(
        "Opublikowane zadania bez wyjaśnienia: 1 z 1; w tym bez cytatu ze źródła: 1. 1 zadanie czekające na sprawdzenie nie ma wyjaśnienia.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Brak wyjaśnienia")).toHaveLength(2);
  });
});

describe("an objective's tasks without an explanation", () => {
  test("are counted and marked on its page too", async () => {
    renderAt("/example/objectives/greetings", {
      braivo: {
        listTasks: async () => [explained, unexplainedCited, bare, waiting, waitingExplained],
        listObjectives: async () => [
          { id: "greetings", title: "Greetings", courseIds: [], pendingTaskCount: 2 },
        ],
        listCourses: async () => [],
        listSources: async () => [],
      },
    });

    expect(
      await screen.findByText(
        "2 of 3 published tasks have no explanation; 1 also cites no passage. 1 task waiting for review has no explanation.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("No explanation")).toHaveLength(3);
  });
});
