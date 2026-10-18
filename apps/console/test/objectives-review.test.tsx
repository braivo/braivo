// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { renderAt } from "./render.tsx";

/** A waiting choice task of `numbers`, citing Unidad 1. */
const task = (id: string, prompt: string, published = false) => ({
  id,
  kind: "choice" as const,
  prompt,
  options: ["Uno", "Dos"],
  answer: 0,
  citations: [{ sourceId: "s1", start: 0, end: 4, quote: "Uno." }],
  published,
});

const numbers = { id: "numbers", title: "Numbers", courseIds: [], waitingTaskCount: 2 };
const sources = [{ id: "s1", title: "Unidad 1", createdAt: "2026-06-01T00:00:00.000Z" }];
const course = (id: string, title: string, published: boolean) => ({
  id,
  number: 1000,
  title,
  urlLabel: title.toLowerCase(),
  published,
  waitingTaskCount: 0,
});

describe("an objective's page", () => {
  test("leads from the organization's page, with no course, to tasks in none", async () => {
    renderAt("/example", {
      braivo: {
        listCourses: async () => [],
        listObjectives: async () => [numbers],
        listTasks: async () => [task("t1", "One?"), task("t2", "Two?")],
        listSources: async () => sources,
      },
    });

    // No course yet, and still something to review.
    expect(await screen.findByText("No courses yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Numbers (2 tasks need review)" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Numbers" })).toBeTruthy();
    expect(
      screen.getByText(
        "In no course: learners are asked its published tasks only once a published course includes it.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /2 tasks below wait for review: learners are asked them once you publish and a published course includes this objective\./,
      ),
    ).toBeTruthy();
    // In Courses, which leads here.
    expect(screen.getByRole("link", { name: "Courses", current: "page" })).toBeTruthy();
  });

  test("publishes the tasks selected, and only those, with no course to name", async () => {
    let published = new Set<string>();
    const publish = vi.fn<BraivoClient["publish"]>(async ({ taskIds }) => {
      published = new Set([...published, ...(taskIds ?? [])]);
    });
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [numbers],
        listTasks: async () =>
          [task("t1", "One?"), task("t2", "Two?")].map((each) => ({
            ...each,
            published: published.has(each.id),
          })),
        listCourses: async () => [],
        listSources: async () => sources,
        publish,
      },
    });

    const selected = await screen.findByRole("button", { name: "Publish selected (0)" });
    expect(selected.hasAttribute("disabled")).toBe(true);
    // Each with the passage it was written from.
    expect(screen.getAllByText("Unidad 1").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select waiting task “Two?”" }));
    // Nothing to name: no published course is reached, so not asked first.
    fireEvent.click(screen.getByRole("button", { name: "Publish selected (1)" }));

    expect(await screen.findByText("Published 1 task.")).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", taskIds: ["t2"] },
      { signal: expect.any(AbortSignal) },
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Numbers" }));
    // One still waits; the other is published.
    const waiting = within(screen.getByRole("region", { name: "Waiting for review" }));
    expect(waiting.getByText("One?")).toBeTruthy();
    expect(waiting.queryByText("Two?")).toBeNull();
    const publishedTasks = within(screen.getByRole("region", { name: "Published tasks" }));
    expect(publishedTasks.getByText("Two?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish all (1)" })).toBeTruthy();
  });

  test("keeps an objective in no course listed once its tasks are published", async () => {
    let published = new Set<string>();
    const tasks = () =>
      [task("t1", "One?"), task("t2", "Two?")].map((each) => ({
        ...each,
        published: published.has(each.id),
      }));
    renderAt("/example", {
      braivo: {
        listCourses: async () => [],
        listObjectives: async () => [
          { ...numbers, waitingTaskCount: tasks().filter((each) => !each.published).length },
        ],
        listTasks: async () => tasks(),
        listSources: async () => sources,
        publish: async ({ taskIds }: { taskIds?: string[] }) => {
          published = new Set([...published, ...(taskIds ?? [])]);
        },
      },
    });

    fireEvent.click(await screen.findByRole("link", { name: "Numbers (2 tasks need review)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish all (2)" }));
    expect(await screen.findByText("Published 2 tasks.")).toBeTruthy();
    // Back by the page's own link, above its title, not the sidebar's.
    fireEvent.click(
      screen.getByRole("heading", { level: 1, name: "Numbers" }).previousElementSibling!,
    );

    // Nothing waits, and no course leads to it: still listed, without a count.
    const listed = await screen.findByRole("link", { name: "Numbers" });
    expect(listed.closest("li")!.textContent).toBe("NumbersIn no course");
    fireEvent.click(listed);
    // Where its published tasks are still edited and retired.
    expect(await screen.findByRole("button", { name: "Retire “Two?”" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit “One?”" })).toBeTruthy();
  });

  test("publishes at once when the courses it is in are unpublished, saying what that means", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [{ ...numbers, courseIds: ["c3"] }],
        listTasks: async () => [task("t1", "One?")],
        listCourses: async () => [course("c3", "Draft", false)],
        listSources: async () => sources,
        publish,
      },
    });

    expect(
      await screen.findByText(
        /learners are asked it once you publish and a published course includes this objective\./,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish all (1)" }));

    // No published course to name, so not asked first.
    expect(await screen.findByText("Published 1 task.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", taskIds: ["t1"] },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("retires a waiting task, focusing the title once none is left waiting", async () => {
    let retired = false;
    const retireTasks = vi.fn<BraivoClient["retireTasks"]>(async () => {
      retired = true;
    });
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [numbers],
        listTasks: async () => [
          task("t0", "Zero?", true),
          ...(retired ? [] : [task("t1", "One?")]),
        ],
        listCourses: async () => [],
        listSources: async () => sources,
        retireTasks,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire waiting task “One?”" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Waiting for review" })).toBeNull(),
    );
    expect(retireTasks).toHaveBeenCalledWith(
      { organizationId: "org-1", taskIds: ["t1"] },
      { signal: expect.any(AbortSignal) },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Numbers" }),
      ),
    );
    expect(screen.getByText("Zero?")).toBeTruthy();
  });

  test("names the published courses its tasks reach before publishing them", async () => {
    const publish = vi.fn<BraivoClient["publish"]>(async () => {});
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [{ ...numbers, courseIds: ["c1", "c2", "c3"] }],
        listTasks: async () => [task("t1", "One?"), task("t0", "Zero?", true)],
        listCourses: async () => [
          course("c1", "Beginners", true),
          course("c2", "Holiday Spanish", true),
          course("c3", "Draft", false),
          course("c4", "Elsewhere", true),
        ],
        listSources: async () => sources,
        publish,
      },
    });

    // The courses it is in, each a link, an unpublished one said so.
    const placed = (await screen.findByRole("link", { name: "Beginners" })).parentElement!;
    expect(placed.textContent).toBe("In Beginners, Holiday Spanish, Draft (not published).");
    expect(within(placed).getByRole("link", { name: "Draft" }).getAttribute("href")).toBe(
      "/example/courses/c3",
    );
    expect(
      screen.getByText(
        /1 task below waits for review: learners aren't asked it until you publish\./,
      ),
    ).toBeTruthy();
    // Its published task, with its own buttons.
    expect(
      within(screen.getByRole("region", { name: "Published tasks" })).getByRole("button", {
        name: "Retire “Zero?”",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Publish all (1)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Publish 1 task?");
    expect(dialog.textContent).toContain("Learners of these courses will be asked it:");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Beginners", "Holiday Spanish"]);
    expect(publish).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Publish" })));
    expect(publish).toHaveBeenCalledWith(
      { organizationId: "org-1", taskIds: ["t1"] },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("waits for an open edit before publishing, as a course's page does", async () => {
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [numbers],
        listTasks: async () => [task("t1", "One?")],
        listCourses: async () => [],
        listSources: async () => sources,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit waiting task “One?”" }));

    expect(screen.getByText("Save or cancel the open edit to publish.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish all (1)" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("says a refused Publish changed nothing, showing the page as it is now", async () => {
    let reads = 0;
    renderAt("/example/objectives/numbers", {
      braivo: {
        listObjectives: async () => [numbers],
        // Retired by someone meanwhile: gone once read again.
        listTasks: async () => (reads++ === 0 ? [task("t1", "One?")] : []),
        listCourses: async () => [],
        listSources: async () => sources,
        publish: async () => {
          throw new BraivoError(409, "A task was retired or corrected since.");
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Publish all (1)" }));

    expect(
      await screen.findByText(
        "Nothing was published: this page changed since it loaded. Review it, then publish.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Waiting for review" })).toBeNull();
    expect(screen.getByText("None yet: learners are not asked about it.")).toBeTruthy();
  });

  test("is not found for an objective the organization does not have", async () => {
    renderAt("/example/objectives/theirs", {
      braivo: {
        listObjectives: async () => [numbers],
        listTasks: async () => {
          throw new BraivoError(404, "Braivo answered 404.");
        },
        listCourses: async () => [],
        listSources: async () => sources,
      },
    });

    expect(
      await screen.findByText("This objective does not exist, or you do not manage it."),
    ).toBeTruthy();
  });
});
