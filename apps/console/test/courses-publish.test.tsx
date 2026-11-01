// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { beginners as unpractised, readCourse as readAny } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

/**
 * `beginners` with a published task for Numbers too, so publishing it leaves
 * no objective without practice, which asks first (its own tests below).
 */
const beginners = {
  ...unpractised,
  objectives: [
    unpractised.objectives[0]!,
    {
      ...unpractised.objectives[1]!,
      tasks: [
        {
          id: "n1",
          kind: "choice" as const,
          prompt: "One, in Spanish?",
          options: ["Uno", "Dos"],
          answer: 0,
          citations: [],
          published: true,
        },
      ],
    },
  ],
};

/** Braivo's `readCourse` answering `beginners` as above. */
async function readCourse(input: { courseId: string }) {
  return input.courseId === beginners.id ? beginners : readAny(input);
}

describe("the console", () => {
  test("holds a tool's course for review until published, then says it was", async () => {
    let published = false;
    const publish = vi.fn<BraivoClient["publish"]>(async () => {
      published = true;
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published,
        }),
        publish,
      },
    });

    expect(
      await screen.findByText(
        "Review it below, the tasks needing review first: learners can't see this course until you publish it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Open to every learner/)).toBeNull();
    // Nor a label for a link that reaches no learner yet.
    expect(screen.queryByRole("textbox", { name: "Label in its link" })).toBeNull();
    // The first on the page, under its title; the label's editor has its own.
    const status = screen.getAllByRole("status")[0]!;
    expect(status.textContent).toBe("");
    const button = screen.getByRole("button", { name: "Publish" });
    button.focus();
    fireEvent.click(button);

    expect(await screen.findByText(/Open to every learner in Example School at/)).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", courseIds: ["course-1"], taskIds: [] },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    // The button gone, the focus goes to the course's title, and the change is said.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Beginners" }),
    );
    expect(status.textContent).toBe("Course published.");
    expect(screen.getByRole("textbox", { name: "Label in its link" })).toBeTruthy();
  });

  test("holds a tool's tasks in a published course until published, naming the other courses first", async () => {
    let published = false;
    const publishing = Promise.withResolvers<void>();
    const publish = vi.fn<BraivoClient["publish"]>(async () => {
      await publishing.promise;
      published = true;
    });
    const [greetings, numbers] = beginners.objectives;
    const proposed = {
      id: "t2",
      kind: "choice" as const,
      prompt: "Goodbye, in Spanish?",
      options: ["Hola", "Adiós"],
      answer: 1,
      citations: [],
    };
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [...greetings!.tasks, { ...proposed, published }],
              otherPublishedCourses: [{ id: "course-9", title: "Holiday Spanish" }],
            },
            numbers!,
          ],
        }),
        publish,
      },
    });

    expect(
      await screen.findByText(
        "1 task below waits for review: learners aren't asked it until you publish.",
      ),
    ).toBeTruthy();
    // The course itself is published: its link is shown, and only the new task waits.
    expect(screen.getByText(/Open to every learner in Example School at/)).toBeTruthy();
    expect(screen.getAllByText("Unpublished")).toHaveLength(1);
    // Retiring a pending task takes nothing from learners, and says so.
    fireEvent.click(
      screen.getByRole("button", { name: "Retire unpublished task “Goodbye, in Spanish?”" }),
    );
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "It was never published, so learners have not been asked it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    // Its objective is in another published course, which it reaches too: asked first.
    fireEvent.click(screen.getByRole("button", { name: "Publish all (1)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Publish 1 task?");
    expect(within(dialog).getByRole("listitem").textContent).toBe("Holiday Spanish");
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    // While it publishes, its button opens no second confirmation.
    const pending = await screen.findByRole("button", { name: "Publishing…" });
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pending);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => publishing.resolve());

    expect((await screen.findByText("Published 1 task.")).getAttribute("role")).toBe("status");
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", courseIds: [], taskIds: ["t2"] },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByText("Unpublished")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  test("marks a tool's pending correction, saying first that changing its task retires it", async () => {
    const [greetings, numbers] = beginners.objectives;
    const [original] = greetings!.tasks;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                original!,
                { ...original!, id: "t2", answer: 1, published: false, replaces: "t1" },
              ],
            },
            numbers!,
          ],
        }),
      },
    });

    expect(
      await screen.findByText(
        "Corrects “Hello, in Spanish?”, which stays published until you publish this.",
      ),
    ).toBeTruthy();
    const retireOriginal = screen.getByRole("button", { name: "Retire “Hello, in Spanish?”" });
    const retireCorrection = screen.getByRole("button", {
      name: "Retire unpublished task “Hello, in Spanish?”",
    });
    // The correction waits first, the task as published beside it to compare, its
    // buttons under What it teaches, with the published tasks.
    const review = screen.getByRole("region", { name: "Needs review" });
    expect(within(review).getByText("As published now:")).toBeTruthy();
    expect(within(review).getAllByText("Hello, in Spanish?")).toHaveLength(2);
    expect(
      within(review)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Edit unpublished task “Hello, in Spanish?”",
      "Retire unpublished task “Hello, in Spanish?”",
    ]);
    expect(
      within(screen.getByRole("region", { name: "What it teaches" })).getAllByText(
        "Hello, in Spanish?",
      ),
    ).toHaveLength(1);
    fireEvent.click(retireOriginal);
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "what they already answered stays. The correction that needs review is retired with it. To change it instead, edit it.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    // The correction's own retirement leaves the task it corrects as it is.
    fireEvent.click(retireCorrection);
    expect((await screen.findByRole("alertdialog")).textContent).not.toContain(
      "The correction that needs review",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    expect(
      await screen.findByText(/The correction that needs review is retired with it\.$/),
    ).toBeTruthy();
  });

  test("publishes a tool's course with its pending tasks, counting them", async () => {
    let published = false;
    const publish = vi.fn<BraivoClient["publish"]>(async () => {
      published = true;
    });
    const [greetings, numbers] = beginners.objectives;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          published,
          objectives: [
            {
              ...greetings!,
              tasks: greetings!.tasks.map((task) => ({ ...task, published })),
            },
            numbers!,
          ],
        }),
        publish,
      },
    });

    // No other course shares its objectives: published without asking.
    fireEvent.click(await screen.findByRole("button", { name: "Publish with all (1)" }));

    expect(await screen.findByText("Published the course and 1 task.")).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", courseIds: ["course-1"], taskIds: ["t1"] },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("publishes the pending tasks selected, an objective's at once, leaving the rest pending", async () => {
    const published = new Set<string>();
    const publishing = Promise.withResolvers<void>();
    const publish = vi.fn<BraivoClient["publish"]>(async ({ taskIds }) => {
      await publishing.promise;
      for (const id of taskIds ?? []) published.add(id);
    });
    const [greetings, numbers] = beginners.objectives;
    const pendingTask = (id: string, prompt: string) => ({
      ...greetings!.tasks[0]!,
      id,
      prompt,
      published: published.has(id),
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                ...greetings!.tasks,
                pendingTask("t2", "Goodbye, in Spanish?"),
                pendingTask("t3", "Thanks, in Spanish?"),
              ],
            },
            { ...numbers!, tasks: [pendingTask("t4", "One, in Spanish?")] },
          ],
        }),
        publish,
      },
    });

    // Nothing selected on opening.
    const selected = await screen.findByRole("button", { name: "Publish selected (0)" });
    expect(selected.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Publish all (3)" })).toBeTruthy();
    // Pending work first, each task once: the published one only under What it teaches.
    const review = screen.getByRole("region", { name: "Needs review" });
    expect(within(review).queryByText("Hello, in Spanish?")).toBeNull();
    const teaches = screen.getByRole("region", { name: "What it teaches" });
    expect(within(teaches).queryByText("Goodbye, in Spanish?")).toBeNull();
    expect(
      within(within(teaches).getByRole("article", { name: "2. Numbers" })).getByText(
        "No published practice: learners skip this objective, and may run out of practice until you publish a task needing review above.",
      ),
    ).toBeTruthy();

    // An objective selects its pending tasks; one of them is then left out.
    const all = within(review).getByRole("checkbox", { name: "Select all 2 of “Greetings”" });
    fireEvent.click(all);
    expect(screen.getByRole("button", { name: "Publish selected (2)" })).toBeTruthy();
    fireEvent.click(
      within(review).getByRole("checkbox", {
        name: "Select unpublished task “Thanks, in Spanish?”",
      }),
    );
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(
      within(review).getByRole("checkbox", { name: "Select unpublished task “One, in Spanish?”" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish selected (2)" }));
    // Only the button sending says so; neither sends another meanwhile.
    expect(screen.getByRole("button", { name: "Publishing…" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Publish all (3)" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => publishing.resolve());

    expect(await screen.findByText("Published 2 tasks.")).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", courseIds: [], taskIds: ["t2", "t4"] },
      { signal: expect.any(AbortSignal) },
    );
    // What was not selected still waits, unselected.
    expect(screen.getByRole("button", { name: "Publish selected (0)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish all (1)" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Needs review" })).getByText("Thanks, in Spanish?"),
    ).toBeTruthy();
  });

  test("publishes a tool's course without its pending tasks, which still wait", async () => {
    let published = false;
    const publish = vi.fn<BraivoClient["publish"]>(async () => {
      published = true;
    });
    const [greetings, numbers] = beginners.objectives;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          published,
          objectives: [
            {
              ...greetings!,
              tasks: greetings!.tasks.map((task) => ({ ...task, published: false })),
            },
            numbers!,
          ],
        }),
        publish,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Publish without tasks needing review" }),
    );
    // Its Greetings' only task waits: asked first, saying so.
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(within(dialog).getByRole("list", { name: "Objectives without practice" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Greetings"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish anyway" }));

    expect(await screen.findByText("Course published.")).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", courseIds: ["course-1"], taskIds: [] },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("button", { name: "Publish all (1)" })).toBeTruthy();
  });

  test("publishes a tool's course with the pending tasks selected, which a correction meanwhile leaves", async () => {
    const [greetings, numbers] = beginners.objectives;
    const task = (id: string, prompt: string) => ({ ...greetings!.tasks[0]!, id, prompt });
    let course = {
      ...beginners,
      published: false,
      objectives: [
        {
          ...greetings!,
          tasks: [
            { ...task("t1", "Hello, in Spanish?"), published: false },
            { ...task("t2", "Goodbye, in Spanish?"), published: false },
          ],
        },
        numbers!,
      ],
    };
    const publish = vi
      .fn<BraivoClient["publish"]>()
      // A tool corrected t1 meanwhile: its correction, t3, is a new task, not selected.
      .mockImplementationOnce(async () => {
        course = {
          ...course,
          objectives: [
            {
              ...course.objectives[0]!,
              tasks: [
                { ...task("t2", "Goodbye, in Spanish?"), published: false },
                { ...task("t3", "Hello, in Spanish?"), published: false },
              ],
            },
            numbers!,
          ],
        };
        throw new BraivoError(409, "Braivo answered 409.");
      })
      .mockImplementationOnce(async () => {
        course = {
          ...course,
          published: true,
          objectives: [
            {
              ...course.objectives[0]!,
              tasks: [
                { ...task("t2", "Goodbye, in Spanish?"), published: true },
                { ...task("t3", "Hello, in Spanish?"), published: false },
              ],
            },
            numbers!,
          ],
        };
      });
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: async () => course, publish },
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all 2 of “Greetings”" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish with selected (2)" }));
    expect(
      await screen.findByText(
        "Nothing was published: this page changed since it loaded. Review it, then publish.",
      ),
    ).toBeTruthy();
    // t2 stays selected; t1 is gone, and its correction is not selected for it.
    expect(screen.getByRole("button", { name: "Publish with all (2)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish with selected (1)" }));

    expect(await screen.findByText("Published the course and 1 task.")).toBeTruthy();
    expect(publish).toHaveBeenLastCalledWith(
      { organizationId: "org-1", courseIds: ["course-1"], taskIds: ["t2"] },
      { signal: expect.any(AbortSignal) },
    );
    // The correction still waits.
    expect(screen.getByRole("button", { name: "Publish all (1)" })).toBeTruthy();
  });

  test("opens one task's editor at a time across both sections", async () => {
    const [greetings, numbers] = beginners.objectives;
    const [original] = greetings!.tasks;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                original!,
                { ...original!, id: "t2", answer: 1, published: false, replaces: "t1" },
              ],
            },
            numbers!,
          ],
        }),
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Edit unpublished task “Hello, in Spanish?”" }),
    );
    // Saving the published task would retire the correction being edited.
    const editOriginal = screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" });
    expect(editOriginal.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editOriginal.hasAttribute("disabled")).toBe(false);
  });

  test("publishes nothing while an edit is open, and opens none while publishing", async () => {
    const publishing = Promise.withResolvers<void>();
    const publish = vi.fn<BraivoClient["publish"]>(() => publishing.promise);
    const [greetings, numbers] = beginners.objectives;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                ...greetings!.tasks,
                { ...greetings!.tasks[0]!, id: "t2", prompt: "Bye?", published: false },
              ],
            },
            numbers!,
          ],
        }),
        publish,
      },
    });

    // Publish's reload would close the editor, losing the edit.
    fireEvent.click(await screen.findByRole("button", { name: "Edit unpublished task “Bye?”" }));
    const all = screen.getByRole("button", { name: "Publish all (1)" });
    expect(all.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Save or cancel the open edit to publish.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(all.hasAttribute("disabled")).toBe(false);

    fireEvent.click(all);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Edit unpublished task “Bye?”" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => publishing.resolve());
  });

  test("names in the confirmation the other courses only the tasks it sends reach", async () => {
    const [greetings, numbers] = beginners.objectives;
    const pendingTask = (id: string, prompt: string) => ({
      ...greetings!.tasks[0]!,
      id,
      prompt,
      published: false,
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [pendingTask("t2", "Bye?")],
              otherPublishedCourses: [{ id: "course-8", title: "Holiday Spanish" }],
            },
            {
              ...numbers!,
              tasks: [pendingTask("t3", "One?")],
              otherPublishedCourses: [{ id: "course-9", title: "Counting" }],
            },
          ],
        }),
        publish: vi.fn(),
      },
    });

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select unpublished task “Bye?”" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish selected (1)" }));
    const selected = await screen.findByRole("alertdialog");
    const courses = (dialog: HTMLElement) =>
      within(within(dialog).getByRole("list", { name: "Courses" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    expect(courses(selected)).toEqual(["Holiday Spanish"]);
    // Numbers' only task waits: said too, with Review them in place of Not yet.
    fireEvent.click(within(selected).getByRole("button", { name: "Review them" }));

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (2)" }));
    const all = await screen.findByRole("alertdialog");
    expect(courses(all)).toEqual(["Counting", "Holiday Spanish"]);
  });

  test("moves the focus to the course's title once an objective's last pending task is retired", async () => {
    let retired = false;
    const [greetings, numbers] = beginners.objectives;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                ...greetings!.tasks,
                ...(retired
                  ? []
                  : [{ ...greetings!.tasks[0]!, id: "t2", prompt: "Bye?", published: false }]),
              ],
            },
            numbers!,
          ],
        }),
        retireTasks: async () => {
          retired = true;
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire unpublished task “Bye?”" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: "Needs review" })).toBeNull(),
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Beginners" }),
      ),
    );
  });

  test("lets Publish be tried again once Braivo does not answer in time", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async (_input, options) => stall(options));
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published: false,
        }),
        publish,
      },
    });
    const button = await screen.findByRole("button", { name: "Publish" });

    vi.useFakeTimers();
    fireEvent.click(button);
    expect(button.textContent).toBe("Publishing…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe("Could not publish. Try again.");
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    // Trying again, the alert goes until this attempt is known.
    fireEvent.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test("carries nothing of publishing one course over to another's page", async () => {
    const publishing = Promise.withResolvers<void>();
    // Read once per course, then again when the first's publication reloads the page.
    let reads = 0;
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async ({ courseId }: { courseId: string }) => {
          reads += 1;
          const title = courseId === "course-1" ? "Beginners" : "Advanced";
          return { ...beginners, id: courseId, title, published: false };
        },
        publish: vi.fn(() => publishing.promise),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));

    await router.navigate({ href: "/example/courses/course-2" });
    const heading = await screen.findByRole("heading", { level: 1, name: "Advanced" });
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    // The first course's publication, done, neither speaks nor moves focus here.
    await act(async () => publishing.resolve());
    await vi.waitFor(() => expect(reads).toBe(3));
    expect(screen.getAllByRole("status")[0]!.textContent).toBe("");
    expect(document.activeElement).not.toBe(heading);
  });

  test("says publishing failed, keeping the button to try again, or reloads what changed", async () => {
    const publish = vi
      .fn<BraivoClient["publish"]>()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockRejectedValueOnce(new BraivoError(409, "Braivo answered 409."));
    const reading = vi.fn(async (input: { courseId: string }) => ({
      ...(await readCourse(input)),
      published: false,
    }));
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, publish } });
    const button = await screen.findByRole("button", { name: "Publish" });
    button.focus();

    fireEvent.click(button);
    const first = await screen.findByRole("alert");
    expect(first.textContent).toBe("Could not publish. Try again.");
    expect(document.activeElement).toBe(button);
    // Another failure, another alert: announced again.
    fireEvent.click(button);
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(first));

    // Something on the page no longer there: it is read again, and that is said.
    const reads = reading.mock.calls.length;
    fireEvent.click(button);
    await vi.waitFor(() => expect(reading.mock.calls.length).toBe(reads + 1));
    expect(
      await screen.findByText(
        "Nothing was published: this page changed since it loaded. Review it, then publish.",
      ),
    ).toBeTruthy();
    // The earlier failures' alert is not said beside it.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Beginners" }),
    );
    // Tried again, what the refusal said goes while the new attempt is under way.
    const status = screen.getByText(
      "Nothing was published: this page changed since it loaded. Review it, then publish.",
    );
    publish.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(status.textContent).toBe("");
  });

  test("deletes a tool's course once asked, opening the organization's courses", async () => {
    const deleteCourse = vi.fn<BraivoClient["deleteCourse"]>(async () => {});
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published: false,
        }),
        deleteCourse,
        listCourses: async () => [],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Delete course" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete “Beginners”?");
    expect(dialog.textContent).toContain(
      "Learners never saw it. Its objectives and tasks stay in Braivo, for other courses. Deleting it can't be undone.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
    expect(deleteCourse).toHaveBeenCalledExactlyOnceWith(
      { organizationId: "org-1", courseId: "course-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("offers no Delete once a course is published, and says one published meanwhile was not deleted", async () => {
    let published = false;
    const deleteCourse = vi
      .fn<BraivoClient["deleteCourse"]>()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockImplementationOnce(async () => {
        published = true;
        throw new BraivoError(409, "Braivo answered 409.");
      });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published,
        }),
        deleteCourse,
      },
    });
    const confirm = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Delete course" }));
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
      );
    };

    // Failed: said, the button kept to try again.
    await confirm();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The course could not be deleted. Try again.",
    );
    // Published by someone meanwhile: the page shows it so, saying why.
    await confirm();
    expect(
      await screen.findByText("Not deleted: someone published this course meanwhile."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete course" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Beginners" }),
    );
  });

  test("deletes nothing while an edit is open, and publishes or edits nothing while deleting", async () => {
    const deleting = Promise.withResolvers<void>();
    const deleteCourse = vi.fn<BraivoClient["deleteCourse"]>(() => deleting.promise);
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    const [greetings, numbers] = beginners.objectives;
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          published: false,
          objectives: [
            { ...greetings!, tasks: [{ ...greetings!.tasks[0]!, published: false }] },
            numbers!,
          ],
        }),
        deleteCourse,
        publish,
        listCourses: async () => [],
      },
    });

    // Leaving the page would lose the edit.
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit unpublished task “Hello, in Spanish?”" }),
    );
    const remove = screen.getByRole("button", { name: "Delete course" });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Save or cancel the open edit to publish or delete.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(remove.hasAttribute("disabled")).toBe(false);

    fireEvent.click(remove);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect(remove.textContent).toBe("Deleting…");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    const all = screen.getByRole("button", { name: "Publish with all (1)" });
    expect(all.hasAttribute("disabled")).toBe(true);
    fireEvent.click(all);
    expect(publish).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Edit unpublished task “Hello, in Spanish?”" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => deleting.resolve());
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test("lets Delete be tried again once Braivo does not answer in time", async () => {
    const deleteCourse = vi.fn<BraivoClient["deleteCourse"]>(async (_input, options) =>
      stall(options),
    );
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published: false,
        }),
        deleteCourse,
      },
    });
    const button = await screen.findByRole("button", { name: "Delete course" });
    const confirm = async () => {
      fireEvent.click(button);
      return within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" });
    };

    const action = await confirm();
    // From the click, so the request's deadline runs on them.
    vi.useFakeTimers();
    fireEvent.click(action);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The course could not be deleted. Try again.",
    );
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(await confirm());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deleteCourse).toHaveBeenCalledTimes(2);
  });

  test("keeps the owner where they went when a Delete they left finishes", async () => {
    const deleting = Promise.withResolvers<void>();
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published: false,
        }),
        deleteCourse: () => deleting.promise,
        listSources: async () => [],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Delete course" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    await act(() =>
      router.navigate({
        to: "/$organizationSlug/sources",
        params: { organizationSlug: "example" },
      }),
    );
    await screen.findByText("No material yet");
    await act(async () => deleting.resolve());

    expect(router.state.location.pathname).toBe("/example/sources");
  });

  test("says nothing of an earlier failed Publish while deleting", async () => {
    const deleting = Promise.withResolvers<void>();
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          published: false,
        }),
        publish: async () => {
          throw new BraivoError(503, "Braivo answered 503.");
        },
        deleteCourse: () => deleting.promise,
        listCourses: async () => [],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not publish. Try again.");

    fireEvent.click(screen.getByRole("button", { name: "Delete course" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => deleting.resolve());
  });

  test("hides a published course once asked, and shows it again without asking", async () => {
    let hidden = false;
    const setCourseHidden = vi.fn<BraivoClient["setCourseHidden"]>(async (input) => {
      hidden = input.hidden;
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          hidden,
        }),
        setCourseHidden,
      },
    });
    const heading = await screen.findByRole("heading", { level: 1, name: "Beginners" });
    expect(screen.getByText(/Open to every learner in Example School at/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide from learners" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Hide “Beginners” from learners?");
    expect(dialog.textContent).toContain(
      "Learners can't open it or practise it until you show it again. What they learned stays.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }));

    expect(await screen.findByText("Hidden from learners.")).toBeTruthy();
    expect(setCourseHidden).toHaveBeenLastCalledWith(
      { organizationId: "org-1", courseId: "course-1", hidden: true },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByText("Hidden")).toBeTruthy();
    expect(
      screen.getByText(
        "Learners can't open this course until you show it again. What they learned stays.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Open to every learner/)).toBeNull();
    // Still published: never deleted.
    expect(screen.queryByRole("button", { name: "Delete course" })).toBeNull();
    expect(document.activeElement).toBe(heading);

    fireEvent.click(screen.getByRole("button", { name: "Show to learners" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText("Shown to learners again.")).toBeTruthy();
    expect(setCourseHidden).toHaveBeenLastCalledWith(
      { organizationId: "org-1", courseId: "course-1", hidden: false },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByText(/Open to every learner in Example School at/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide from learners" })).toBeTruthy();
  });

  test("says hiding failed, keeping the button to try again, and neither hides while editing nor edits while hiding", async () => {
    const hiding = Promise.withResolvers<void>();
    const setCourseHidden = vi
      .fn<BraivoClient["setCourseHidden"]>()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockImplementationOnce(() => hiding.promise);
    renderAt("/example/courses/course-1", { braivo: { readCourse, setCourseHidden } });

    const hide = await screen.findByRole("button", { name: "Hide from learners" });
    fireEvent.click(hide);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Hide" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The course could not be hidden. Try again.",
    );

    // Signing in again, were the session over, would lose the edit.
    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    expect(hide.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hide.hasAttribute("disabled")).toBe(false);

    // Nor does an editor open while it hides.
    fireEvent.click(hide);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Hide" }),
    );
    expect(await screen.findByRole("button", { name: "Hiding…" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => hiding.resolve());
    expect(await screen.findByText("Hidden from learners.")).toBeTruthy();
  });

  test("hides nothing while publishing, and publishes nothing while hiding, clearing what Publish said", async () => {
    const publishing = Promise.withResolvers<void>();
    const hiding = Promise.withResolvers<void>();
    const publish = vi
      .fn<BraivoClient["publish"]>()
      .mockImplementationOnce(() => publishing.promise)
      .mockImplementation(async () => {});
    const setCourseHidden = vi.fn<BraivoClient["setCourseHidden"]>(() => hiding.promise);
    const [greetings, numbers] = beginners.objectives;
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [
            {
              ...greetings!,
              tasks: [
                ...greetings!.tasks,
                { ...greetings!.tasks[0]!, id: "t2", prompt: "Bye?", published: false },
              ],
            },
            numbers!,
          ],
        }),
        publish,
        setCourseHidden,
      },
    });
    const hide = await screen.findByRole("button", { name: "Hide from learners" });
    const all = screen.getByRole("button", { name: "Publish all (1)" });

    fireEvent.click(all);
    expect(hide.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hide);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => publishing.resolve());
    expect(await screen.findByText("Published 1 task.")).toBeTruthy();

    fireEvent.click(hide);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Hide" }),
    );
    // What Publish said no longer holds.
    expect(screen.queryByText("Published 1 task.")).toBeNull();
    expect(screen.getByRole("button", { name: "Publish all (1)" }).hasAttribute("disabled")).toBe(
      true,
    );
    await act(async () => hiding.resolve());
    expect(await screen.findByText("Hidden from learners.")).toBeTruthy();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
