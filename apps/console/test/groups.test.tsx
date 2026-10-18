// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type LearnerProgressReport, type Organization } from "@braivo/server/client";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { courseProgress, members, readCourse, school } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

describe("groups", () => {
  /** `school` to someone who teaches there and administers nothing. */
  const taught: Organization = { ...school, administers: false };
  const person = (userId: string, name: string) => ({ userId, name });
  const beginners = { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" };
  /** Two groups sharing a course, as two classes taught the same subject. */
  const sevenA = {
    id: "g1",
    organizationId: "org-1",
    name: "7A · English",
    teachers: [person("u1", "Olive Owner")],
    learners: [person("u2", "Lee Learner")],
    courses: [beginners],
  };
  const sevenB = {
    ...sevenA,
    id: "g2",
    name: "7B · English",
    learners: [person("u2", "Lee Learner"), person("u3", "Lou Learner")],
  };
  /** Administrators' reads, which a teacher's pages must never make. */
  function administratorReads() {
    const refuse = () =>
      vi.fn(async () => Promise.reject(new BraivoError(403, "Braivo answered 403.")));
    return {
      listCourses: refuse(),
      listMembers: refuse(),
      readCourse: refuse(),
      listSources: refuse(),
      listDomains: refuse(),
    };
  }
  const report: LearnerProgressReport = {
    modelVersion: "v1",
    objectives: [{ objectiveId: "o1", title: "Greetings", phase: "unseen", evidence: [] }],
  };

  describe("teaching", () => {
    test("sends a teacher from / to their groups, the only section they have", async () => {
      const reads = administratorReads();
      const { router } = renderAt("/", {
        organizations: [taught],
        braivo: { ...reads, listGroups: async () => [sevenA] },
      });

      expect(await screen.findByRole("heading", { name: "7A · English" })).toBeTruthy();
      expect(router.state.location.pathname).toBe("/example/groups");
      const nav = screen.getByRole("navigation", { name: "Example School" });
      expect(
        within(nav)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Groups"]);
      expect(screen.getByText("Taught by Olive Owner.")).toBeTruthy();
      // Its learners' toggle named with the group, reached apart from its card.
      expect(screen.getByLabelText("7A · English: 1 learner").textContent).toBe("1 learner");
      expect(screen.getByRole("link", { name: /Beginners/ }).getAttribute("href")).toBe(
        "/example/courses/course-1/progress?from=groups",
      );
      // Groups are an administrator's to change.
      expect(screen.queryByRole("link", { name: "Manage groups" })).toBeNull();
      expect(screen.queryByRole("link", { name: /^Edit/ })).toBeNull();
      expect(Object.values(reads).flatMap((read) => read.mock.calls)).toEqual([]);
    });

    test("reports a course across every group a teacher teaches it to, then one learner, and back as left", async () => {
      const reads = administratorReads();
      const courseProgress = vi.fn(async () => ({
        open: true,
        modelVersion: "v1",
        learners: [
          {
            userId: "u2",
            name: "Lee Learner",
            standings: { unseen: 0, acquiring: 1, retained: 0, due: 0 },
          },
          {
            userId: "u3",
            name: "Lou Learner",
            standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
          },
        ],
        objectives: [
          {
            objectiveId: "o1",
            title: "Greetings",
            standings: { unseen: 1, acquiring: 1, retained: 0, due: 0 },
          },
        ],
      }));
      const learnerProgress = vi.fn(async () => report);
      const { router } = renderAt("/example/courses/course-1/progress?from=groups", {
        organizations: [taught],
        braivo: {
          ...reads,
          listGroups: async () => [sevenA, sevenB],
          courseProgress,
          learnerProgress,
        },
      });

      expect(
        await screen.findByText(
          "2 learners you teach in this course, across your groups: 7A · English and 7B · English.",
        ),
      ).toBeTruthy();
      // What the teacher sends them, to the course itself.
      expect(
        screen
          .getByRole("link", { name: "example.braivo.app/c/4732-beginners" })
          .getAttribute("href"),
      ).toBe("https://example.braivo.app/c/4732-beginners");
      // Found by name, the objectives still counting everyone.
      fireEvent.change(screen.getByRole("searchbox", { name: "Find a learner" }), {
        target: { value: "lou" },
      });
      const learners = screen.getByRole("table", { name: "Learners" });
      await vi.waitFor(() =>
        expect(
          within(learners)
            .getAllByRole("rowheader")
            .map((cell) => cell.textContent),
        ).toEqual(["Lou Learner"]),
      );
      expect(
        within(screen.getByRole("table", { name: "Progress by objective" })).getAllByRole(
          "cell",
        )[0]!.textContent,
      ).toBe("1");

      fireEvent.click(within(learners).getByRole("link", { name: "Lou Learner" }));
      expect(await screen.findByRole("heading", { name: "Lou Learner" })).toBeTruthy();
      expect(screen.getByText(/Estimates include learning across/)).toBeTruthy();
      fireEvent.click(screen.getByRole("link", { name: "Beginners" }));
      expect(await screen.findByRole("searchbox", { name: "Find a learner" })).toHaveProperty(
        "value",
        "lou",
      );
      expect(router.state.location.search).toEqual({ from: "groups", q: "lou" });
      expect(learnerProgress).toHaveBeenCalledWith(
        { courseId: "course-1", learnerId: "u3" },
        { signal: expect.any(AbortSignal) },
      );
      expect(Object.values(reads).flatMap((read) => read.mock.calls)).toEqual([]);
    });

    test("finds a learner as typed without a navigation per keystroke, the report leading back to it", async () => {
      const listOrganizations = vi.fn(async () => [taught]);
      const { router } = renderAt("/example/courses/course-1/progress", {
        organizations: [taught],
        braivo: {
          listOrganizations,
          listGroups: async () => [sevenB],
          courseProgress: async () => ({
            open: true,
            modelVersion: "v1",
            learners: [
              {
                userId: "x-111111",
                name: "Ana",
                standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
              },
              {
                userId: "y-222222",
                name: "Ana",
                standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
              },
              {
                userId: "u3",
                name: "Lou Learner",
                standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
              },
            ],
            objectives: [],
          }),
        },
      });
      const search = await screen.findByRole("searchbox", { name: "Find a learner" });
      // A teacher's course pages are in Groups, wherever opened from.
      expect(
        within(screen.getByRole("navigation", { name: "Example School" }))
          .getByRole("link", { name: "Groups" })
          .getAttribute("aria-current"),
      ).toBe("true");
      const reads = listOrganizations.mock.calls.length;
      for (const typed of ["a", "an", "ana"])
        fireEvent.change(search, { target: { value: typed } });

      const learners = screen.getByRole("table", { name: "Learners" });
      // Filtered at once; two Anas told apart, in their links' names too.
      expect(
        within(learners)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Ana111111", "Ana222222"]);
      expect(listOrganizations.mock.calls.length).toBe(reads);
      expect(within(learners).getAllByRole("link")[0]!.getAttribute("href")).toBe(
        "/example/courses/course-1/learners/x-111111?q=ana",
      );
      await vi.waitFor(() => expect(router.state.location.search).toEqual({ q: "ana" }));
    });

    test("keeps a learner searched for when a report opens before the URL caught up, for Back", async () => {
      const { router } = renderAt("/example/courses/course-1/progress", {
        organizations: [taught],
        braivo: {
          listGroups: async () => [sevenB],
          learnerProgress: async () => report,
          courseProgress: async () => ({
            open: true,
            modelVersion: "v1",
            learners: [
              {
                userId: "u2",
                name: "Lee Learner",
                standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
              },
              {
                userId: "u3",
                name: "Lou Learner",
                standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
              },
            ],
            objectives: [],
          }),
        },
      });
      const search = await screen.findByRole("searchbox", { name: "Find a learner" });
      fireEvent.change(search, { target: { value: "lou" } });
      // A click blurs the field first.
      fireEvent.blur(search);
      fireEvent.click(screen.getByRole("link", { name: "Lou Learner" }));
      expect(await screen.findByRole("heading", { name: "Lou Learner" })).toBeTruthy();

      await act(async () => router.history.back());
      expect(await screen.findByRole("searchbox", { name: "Find a learner" })).toHaveProperty(
        "value",
        "lou",
      );
    });

    test("shows the query navigated to, in this course or another, over one typed before", async () => {
      const advanced = { id: "course-2", number: 5810, title: "Advanced", urlLabel: "advanced" };
      const progress = async () => ({
        open: true,
        modelVersion: "v1",
        learners: [
          {
            userId: "u2",
            name: "Lee Learner",
            standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
          },
          {
            userId: "u3",
            name: "Lou Learner",
            standings: { unseen: 1, acquiring: 0, retained: 0, due: 0 },
          },
        ],
        objectives: [],
      });
      const { router } = renderAt("/example/courses/course-1/progress?q=Lee", {
        organizations: [taught],
        braivo: {
          listGroups: async () => [{ ...sevenB, courses: [beginners, advanced] }],
          courseProgress: progress,
        },
      });
      const rows = () =>
        within(screen.getByRole("table", { name: "Learners" }))
          .getAllByRole("rowheader")
          .map((cell) => cell.textContent);
      const search = await screen.findByRole("searchbox", { name: "Find a learner" });
      expect(rows()).toEqual(["Lee Learner"]);

      await act(() =>
        router.navigate({
          to: "/$organizationSlug/courses/$courseId/progress",
          params: { organizationSlug: "example", courseId: "course-1" },
          search: { q: "Lou" },
        }),
      );
      await vi.waitFor(() => expect(search).toHaveProperty("value", "Lou"));
      expect(rows()).toEqual(["Lou Learner"]);

      // Typed, then another course opened before the URL caught up.
      fireEvent.change(search, { target: { value: "Le" } });
      await act(() =>
        router.navigate({
          to: "/$organizationSlug/courses/$courseId/progress",
          params: { organizationSlug: "example", courseId: "course-2" },
        }),
      );
      expect(await screen.findByRole("heading", { name: "Advanced" })).toBeTruthy();
      expect(screen.getByRole("searchbox", { name: "Find a learner" })).toHaveProperty("value", "");
      expect(rows()).toEqual(["Lee Learner", "Lou Learner"]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(router.state.location.pathname).toBe("/example/courses/course-2/progress");
      expect(router.state.location.search).toEqual({});
    });

    test("leaves a search typed unsent once another page, slow to load, is navigated to", async () => {
      const advanced = { id: "course-2", number: 5810, title: "Advanced", urlLabel: "advanced" };
      const listGroups = vi.fn(async () => [{ ...sevenB, courses: [beginners, advanced] }]);
      const progress = vi.fn(courseProgress);
      const { router } = renderAt("", {
        organizations: [taught],
        braivo: { listGroups, courseProgress: progress },
        history: createMemoryHistory({
          initialEntries: ["/example/groups", "/example/courses/course-1/progress?from=groups"],
          initialIndex: 1,
        }),
      });
      /** Holds the next read until released, longer than typing waits to be sent. */
      const held = (read: typeof listGroups | typeof progress) => {
        let release!: () => void;
        read.mockImplementationOnce(async (...args: never[]) => {
          await new Promise<void>((resolve) => (release = resolve));
          return (read.getMockImplementation() as (...args: never[]) => never)(...args);
        });
        return () => act(async () => release());
      };

      // Another course, typed in before it was opened.
      fireEvent.change(await screen.findByRole("searchbox", { name: "Find a learner" }), {
        target: { value: "Lee" },
      });
      let release = held(progress);
      void router.navigate({
        to: "/$organizationSlug/courses/$courseId/progress",
        params: { organizationSlug: "example", courseId: "course-2" },
      });
      await new Promise((resolve) => setTimeout(resolve, 550));
      await release();
      expect(await screen.findByRole("heading", { name: "Advanced" })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(router.state.location.pathname).toBe("/example/courses/course-2/progress");
      expect(router.state.location.search).toEqual({});
      expect(screen.getByRole("searchbox", { name: "Find a learner" })).toHaveProperty("value", "");

      // Back to Groups, typed in with the field still focused.
      await act(async () => router.history.go(-1));
      fireEvent.change(await screen.findByRole("searchbox", { name: "Find a learner" }), {
        target: { value: "Lee" },
      });
      release = held(listGroups);
      await act(async () => router.history.go(-1));
      await new Promise((resolve) => setTimeout(resolve, 550));
      await release();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(router.state.location.pathname).toBe("/example/groups");
      expect(router.state.location.search).toEqual({});
    });

    test("keeps a search typed while the URL was catching up, even back to what it was", async () => {
      const listOrganizations = vi.fn(async () => [taught]);
      const { router } = renderAt("/example/courses/course-1/progress", {
        organizations: [taught],
        braivo: { listOrganizations, listGroups: async () => [sevenB], courseProgress },
      });
      const search = await screen.findByRole("searchbox", { name: "Find a learner" });
      // The URL's next check held until released.
      let release!: () => void;
      listOrganizations.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve([taught]))),
      );
      const reads = listOrganizations.mock.calls.length;
      fireEvent.change(search, { target: { value: "Lee" } });
      await vi.waitFor(() => expect(listOrganizations.mock.calls.length).toBe(reads + 1));
      fireEvent.change(search, { target: { value: "" } });
      await act(async () => release());

      await vi.waitFor(() => expect(router.state.location.search).toEqual({ q: "Lee" }));
      expect(search).toHaveProperty("value", "");
      await vi.waitFor(() => expect(router.state.location.search).toEqual({}));
      expect(search).toHaveProperty("value", "");

      // Sent again, then superseded by an order chosen before it arrived.
      listOrganizations.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve([taught]))),
      );
      fireEvent.change(search, { target: { value: "Lee" } });
      await vi.waitFor(() => expect(listOrganizations.mock.calls.length).toBe(reads + 3));
      fireEvent.change(search, { target: { value: "" } });
      fireEvent.change(screen.getByRole("combobox", { name: "Order" }), {
        target: { value: "due" },
      });
      await act(async () => release());
      await vi.waitFor(() => expect(router.state.location.search).toEqual({ sort: "due" }));
      // Typed again, it still reaches the URL.
      fireEvent.change(search, { target: { value: "Lee" } });
      await vi.waitFor(() =>
        expect(router.state.location.search).toEqual({ q: "Lee", sort: "due" }),
      );
    });

    test("keeps a pasted search to what the URL holds, which it then stops chasing", async () => {
      const listOrganizations = vi.fn(async () => [taught]);
      const { router } = renderAt("/example/courses/course-1/progress", {
        organizations: [taught],
        braivo: { listOrganizations, listGroups: async () => [sevenB], courseProgress },
      });
      const search = await screen.findByRole("searchbox", { name: "Find a learner" });
      fireEvent.change(search, { target: { value: "x".repeat(1000) } });
      expect(search).toHaveProperty("value", "x".repeat(200));
      await vi.waitFor(() => expect(router.state.location.search).toEqual({ q: "x".repeat(200) }));
      const reads = listOrganizations.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(listOrganizations.mock.calls.length).toBe(reads);
      expect(search).toHaveProperty("value", "x".repeat(200));
    });

    test("tags a learner whose name another shares in their report's heading", async () => {
      const twin = { ...sevenB, learners: [person("x-111111", "Ana"), person("y-222222", "Ana")] };
      renderAt("/example/courses/course-1/learners/y-222222", {
        organizations: [taught],
        braivo: { listGroups: async () => [twin], learnerProgress: async () => report },
      });

      expect(await screen.findByRole("heading", { name: /^Ana\s*222222$/ })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toContain("Ana 222222"));
    });

    test("orders learners by what they are learning or have due, then by name", async () => {
      const standings = (acquiring: number, due: number) => ({
        unseen: 0,
        acquiring,
        retained: 0,
        due,
      });
      renderAt("/example/courses/course-1/progress?sort=due", {
        organizations: [taught],
        braivo: {
          listGroups: async () => [sevenB],
          courseProgress: async () => ({
            open: true,
            modelVersion: "v1",
            learners: [
              { userId: "u2", name: "Lee Learner", standings: standings(2, 0) },
              { userId: "u3", name: "Lou Learner", standings: standings(0, 3) },
              { userId: "u4", name: "Ada Learner", standings: standings(0, 3) },
            ],
            objectives: [],
          }),
        },
      });

      const learners = await screen.findByRole("table", { name: "Learners" });
      const names = () =>
        within(learners)
          .getAllByRole("rowheader")
          .map((cell) => cell.textContent);
      expect(names()).toEqual(["Ada Learner", "Lou Learner", "Lee Learner"]);
      fireEvent.change(screen.getByLabelText("Order"), { target: { value: "learning" } });
      await vi.waitFor(() =>
        expect(names()).toEqual(["Lee Learner", "Ada Learner", "Lou Learner"]),
      );
    });

    test("reads nothing about a course or learner a teacher's groups do not hold", async () => {
      const courseProgress = vi.fn(async () => ({
        open: true,
        modelVersion: "v1",
        learners: [],
        objectives: [],
      }));
      const learnerProgress = vi.fn(async () => report);
      renderAt("/example/courses/course-2/progress", {
        organizations: [taught],
        braivo: { listGroups: async () => [sevenA], courseProgress, learnerProgress },
      });
      expect(
        await screen.findByText("This course does not exist, or its progress is not yours to see."),
      ).toBeTruthy();
      cleanup();

      renderAt("/example/courses/course-1/learners/u3", {
        organizations: [taught],
        braivo: { listGroups: async () => [sevenA], courseProgress, learnerProgress },
      });
      expect(
        await screen.findByText(
          "This learner does not exist, or their progress is not yours to see.",
        ),
      ).toBeTruthy();
      expect({
        courseProgress: courseProgress.mock.calls,
        learnerProgress: learnerProgress.mock.calls,
      }).toEqual({ courseProgress: [], learnerProgress: [] });
    });

    test.each([
      ["/example/sources"],
      ["/example/sources/s1"],
      ["/example/courses/course-1"],
      ["/example/settings/general"],
      ["/example/settings/members"],
      ["/example/settings/domains"],
      ["/example/settings/groups"],
      ["/example/settings/groups/new"],
      ["/example/settings/groups/g1"],
    ])("refuses a teacher %s before reading anything", async (path) => {
      const reads = administratorReads();
      const listGroups = vi.fn(async () => [sevenA]);
      renderAt(path, { organizations: [taught], braivo: { ...reads, listGroups } });

      expect(
        await screen.findByText(
          /There is no such setting|does not exist, or you do not manage it|This group does not exist, or is not yours to change/,
        ),
      ).toBeTruthy();
      expect(Object.values(reads).flatMap((read) => read.mock.calls)).toEqual([]);
      expect(listGroups.mock.calls).toEqual([]);
    });

    test("offers a teacher their account's settings, not the organization's", async () => {
      renderAt("/example/settings/account", { organizations: [taught] });

      const nav = await screen.findByRole("navigation", { name: "Settings" });
      expect(
        within(nav)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["Back to Example School", "Profile", "Preferences", "Connected apps"]);
    });

    test("takes a report away, its learner's name included, once the teacher no longer teaches them", async () => {
      let groups = [sevenA];
      const { router } = renderAt("/example/courses/course-1/learners/u2", {
        organizations: [taught],
        braivo: { listGroups: async () => groups, learnerProgress: async () => report },
      });
      expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toContain("Lee Learner"));

      groups = [];
      await act(() => router.invalidate());

      expect(
        await screen.findByText(
          "This learner does not exist, or their progress is not yours to see.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Lee Learner")).toBeNull();
      expect(document.title).not.toContain("Lee Learner");
    });

    test("shows an administrator who teaches every group, with a way to manage them", async () => {
      renderAt("/example/groups", { braivo: { listGroups: async () => [sevenA, sevenB] } });

      expect(await screen.findByRole("heading", { name: "7B · English" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Manage groups" }).getAttribute("href")).toBe(
        "/example/settings/groups",
      );
      expect(screen.getByRole("link", { name: "Edit 7A · English" }).getAttribute("href")).toBe(
        "/example/settings/groups/g1",
      );
    });

    test("keeps Groups marked in an administrator's report opened from it, and its learners'", async () => {
      const { router } = renderAt("/example/courses/course-1/progress?from=groups", {
        braivo: {
          listCourses: async () => [beginners],
          readCourse,
          courseProgress,
          listMembers: async () => members,
          learnerProgress: async () => report,
        },
      });
      const nav = await screen.findByRole("navigation", { name: "Example School" });
      const marked = () =>
        within(nav)
          .getAllByRole("link")
          .filter((link) => link.getAttribute("aria-current") === "true")
          .map((link) => link.textContent);
      await vi.waitFor(() => expect(marked()).toEqual(["Groups"]));

      fireEvent.click(await screen.findByRole("link", { name: "Lee Learner" }));
      expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
      expect(marked()).toEqual(["Groups"]);

      // Opened from the course, both are in Courses.
      await act(() =>
        router.navigate({
          to: "/$organizationSlug/courses/$courseId/progress",
          params: { organizationSlug: "example", courseId: "course-1" },
        }),
      );
      await vi.waitFor(() => expect(marked()).toEqual(["Courses"]));
      fireEvent.click(await screen.findByRole("link", { name: "Lee Learner" }));
      expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
      expect(marked()).toEqual(["Courses"]);
      // The course itself stays in Courses, whatever its URL says.
      await act(() => router.navigate({ href: "/example/courses/course-1?from=groups" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Beginners" })).toBeTruthy();
      expect(marked()).toEqual(["Courses"]);
    });
  });

  describe("managing", () => {
    const tutoring = {
      id: "g3",
      organizationId: "org-1",
      name: "Tutoring",
      teachers: [],
      learners: [],
      courses: [],
    };
    const people = [
      { userId: "u1", name: "Olive Owner", roles: ["owner"] },
      { userId: "u2", name: "Lee Learner", roles: ["member"] },
      { userId: "u3", name: "Lou Learner", roles: ["member"] },
    ];

    test("lists the groups, counted, found by name, and says when none is", async () => {
      renderAt("/example/settings/groups", {
        braivo: { listGroups: async () => [sevenA, tutoring] },
      });

      const table = await screen.findByRole("table");
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual(["7A · English111", "Tutoring000"]);
      expect(within(table).getByRole("link", { name: "Tutoring" }).getAttribute("href")).toBe(
        "/example/settings/groups/g3",
      );
      fireEvent.change(screen.getByRole("searchbox", { name: "Find a group" }), {
        target: { value: "8B" },
      });
      expect(await screen.findByText("No group matches “8B”.")).toBeTruthy();
      cleanup();

      renderAt("/example/settings/groups", { braivo: { listGroups: async () => [] } });
      expect(await screen.findByText("No groups yet")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Create group" }).getAttribute("href")).toBe(
        "/example/settings/groups/new",
      );
    });

    test("while the table hides columns, fades its edge and is a tab stop; pins its names", async () => {
      renderAt("/example/settings/groups", {
        braivo: { listGroups: async () => [sevenA, tutoring] },
      });
      const table = await screen.findByRole("table");
      const container = table.parentElement!;
      const wrapper = container.parentElement!;
      const faded = () => wrapper.className.includes("mask-r-from");
      expect(faded()).toBe(false);
      expect(wrapper.dataset.scrolled).toBeUndefined();
      // happy-dom lays nothing out: the container 300px wide, its table 450px.
      Object.defineProperties(container, {
        clientWidth: { value: 300 },
        scrollWidth: { value: 450 },
      });

      expect(container.hasAttribute("tabindex")).toBe(false);
      fireEvent.scroll(container);
      await vi.waitFor(() => expect(faded()).toBe(true));
      // A tab stop while it scrolls, so the keyboard reaches what it hides,
      // named as its table is.
      expect(container.tabIndex).toBe(0);
      expect(container.getAttribute("role")).toBe("region");
      expect(container.getAttribute("aria-labelledby")).toBe(table.getAttribute("aria-labelledby"));
      container.scrollLeft = 150;
      fireEvent.scroll(container);
      await vi.waitFor(() => expect(faded()).toBe(false));
      expect(wrapper.dataset.scrolled).toBe("true");
      for (const name of ["Name", "7A · English"]) {
        expect(within(table).getByText(name).closest("th")!.className).toContain("sticky");
      }
    });

    test("measures the table again when it or its container resizes, not only when it scrolls", async () => {
      const observers: { callback: () => void; observed: Element[] }[] = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observed: Element[] = [];
          constructor(callback: () => void) {
            observers.push({ callback, observed: this.observed });
          }
          observe(element: Element) {
            this.observed.push(element);
          }
          disconnect() {}
        },
      );
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      renderAt("/example/settings/groups", {
        braivo: { listGroups: async () => [sevenA, tutoring] },
      });
      const table = await screen.findByRole("table");
      const container = table.parentElement!;
      const faded = () => container.parentElement!.className.includes("mask-r-from");
      const observer = observers.find(({ observed }) => observed.includes(container))!;
      // The table too: a language's longer words widen it, not its container.
      expect(observer.observed).toContain(table);
      // happy-dom lays nothing out: the container 300px wide, its table as wide, then wider.
      let tableWidth = 300;
      Object.defineProperties(container, {
        clientWidth: { value: 300 },
        scrollWidth: { get: () => tableWidth },
      });
      const resize = () => act(() => observer.callback());

      resize();
      expect(faded()).toBe(false);
      tableWidth = 450;
      resize();
      expect(faded()).toBe(true);
      expect(container.tabIndex).toBe(0);
    });

    /** Picks `name` from the picker `opener` opens, by keyboard: typed, then Enter. */
    async function pick(opener: string, name: string) {
      const button = screen.getByRole("button", { name: opener });
      fireEvent.click(button);
      await screen.findAllByRole("option");
      // The open picker's: Radix hides the page around it from the role query.
      const search = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
      fireEvent.change(search, { target: { value: name } });
      await vi.waitFor(() =>
        expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([name]),
      );
      fireEvent.keyDown(search, { key: "Enter" });
      fireEvent.keyDown(search, { key: "Escape" });
      // Closed once the focus is back, which would otherwise close the next one opened.
      await vi.waitFor(() => expect(document.activeElement).toBe(button));
    }

    test("creates a group whole, retrying an unconfirmed creation under the same key", async () => {
      let attempts = 0;
      const defineGroup = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return "g9";
      });
      const created = { ...tutoring, id: "g9", name: "8A" };
      let groups = [sevenA];
      const { router } = renderAt("/example/settings/groups/new", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups: async () => groups,
          defineGroup: async (...args: unknown[]) => {
            const id = await defineGroup(...(args as []));
            groups = [sevenA, created];
            return id;
          },
        },
      });

      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: " 8A " },
      });
      await pick("Add teachers", "Olive Owner");
      await pick("Add learners", "Lee Learner");
      // Already a teacher: moved only by their row's action.
      fireEvent.click(screen.getByRole("button", { name: "Add learners" }));
      expect(
        (await screen.findByRole("option", { name: /^Olive Owner/ })).getAttribute("aria-disabled"),
      ).toBe("true");
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add learners" })),
      );
      await pick("Add courses", "Beginners");
      expect(
        screen.getByText("1 teacher will be able to read progress for 1 learner in 1 course."),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not confirm the group was created.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));

      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe("/example/settings/groups/g9"),
      );
      const [[first], [second]] = defineGroup.mock.calls as unknown as [[object], [object]];
      // The same group, under the same key: never created twice.
      expect(second).toEqual(first);
      expect(first).toEqual({
        organizationId: "org-1",
        key: expect.any(String),
        name: "8A",
        teacherIds: ["u1"],
        learnerIds: ["u2"],
        courseIds: ["course-1"],
      });
    });

    test("frees an unconfirmed creation's form once trying again is refused, under the same key", async () => {
      const defineGroup = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new BraivoError(400, "Braivo answered 400."))
        .mockResolvedValueOnce("g9");
      const { router } = renderAt("/example/settings/groups/new", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups: async () => [sevenA],
          defineGroup,
        },
      });
      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "8A" },
      });
      await pick("Add learners", "Lee Learner");
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      expect((await screen.findByRole("alert")).textContent).toContain("the same group is sent");
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Braivo refused this group");

      // Refused, nothing was created: what was sent is theirs to change.
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("readOnly", false);
      fireEvent.click(screen.getByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe("/example/settings/groups/g9"),
      );
      const [[first], , [third]] = defineGroup.mock.calls as [[object], [object], [object]];
      expect(first).toMatchObject({ learnerIds: ["u2"] });
      expect(third).toEqual({ ...first, learnerIds: [] });
    });

    test("holds an unconfirmed creation as sent, and leaves a page left meanwhile alone", async () => {
      let attempts = 0;
      let answer!: (id: string) => void;
      const defineGroup = vi.fn(() =>
        (attempts += 1) === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : new Promise<string>((resolve) => (answer = resolve)),
      );
      const { router } = renderAt("/example/settings/groups/new", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups: async () => [sevenA],
          defineGroup,
        },
      });
      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "8A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      expect((await screen.findByRole("alert")).textContent).toContain("the same group is sent");

      // Held as sent: nothing to change until it is confirmed.
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("readOnly", true);
      expect(
        screen.getByRole("button", { name: "Add teachers" }).closest("fieldset[disabled]"),
      ).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      await vi.waitFor(() => expect(defineGroup).toHaveBeenCalledTimes(2));
      const [[first], [second]] = defineGroup.mock.calls as unknown as [[object], [object]];
      expect(second).toEqual(first);

      // Left while it is sent: its answer moves nobody back to it.
      await act(() =>
        router.navigate({
          to: "/$organizationSlug/settings/groups",
          params: { organizationSlug: "example" },
        }),
      );
      await act(async () => answer("g9"));
      expect(router.state.location.pathname).toBe("/example/settings/groups");
    });

    test("says a changed form's creation was refused when the first already landed, and lets them leave", async () => {
      const confirm = vi.fn(() => false);
      vi.stubGlobal("confirm", confirm);
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const { router } = renderAt("/example/settings/groups/new", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups: async () => [],
          defineGroup: async () => {
            throw new BraivoError(409, "Braivo answered 409.");
          },
        },
      });
      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "8A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("A group was already created from this form.");
      const toGroups = within(alert).getByRole("link", { name: "See groups" });
      expect(toGroups.getAttribute("href")).toBe("/example/settings/groups");
      // Nothing left here to lose: the group exists.
      fireEvent.click(toGroups);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe("/example/settings/groups"),
      );
      expect(confirm).not.toHaveBeenCalled();
    });

    test("asks for a name, sending nothing without one", async () => {
      const defineGroup = vi.fn();
      renderAt("/example/settings/groups/new", {
        braivo: { listMembers: async () => people, listCourses: async () => [], defineGroup },
      });
      const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
      fireEvent.change(name, { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));

      expect(name.validationMessage).toBe("Enter the group's name.");
      expect(defineGroup).not.toHaveBeenCalled();
      // No course to add: where courses come from instead.
      expect(screen.getByRole("link", { name: "See sources" })).toBeTruthy();
    });

    function renderGroup(
      changeGroup: (...args: never[]) => Promise<unknown>,
      read: () => unknown = () => sevenB,
      members = people,
    ) {
      const listGroups = vi.fn(async () => [read()]);
      const rendered = renderAt("/example/settings/groups/g2", {
        braivo: {
          listMembers: async () => members,
          listCourses: async () => [beginners],
          listGroups,
          changeGroup,
        },
      });
      return { ...rendered, listGroups };
    }

    test("sends only what changed: a role changed by removing and adding, nothing when nothing did", async () => {
      const changeGroup = vi.fn(async () => sevenB);
      renderGroup(changeGroup);

      fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
      expect(await screen.findByText("Nothing to save: the group is as shown.")).toBeTruthy();
      expect(changeGroup).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Change to teacher: Lou Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove Lee Learner" }));
      expect(screen.getByText(/Removing someone keeps their learning history/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
      expect(changeGroup).toHaveBeenCalledWith(
        {
          organizationId: "org-1",
          groupId: "g2",
          add: { teacherIds: ["u3"] },
          remove: { userIds: ["u3", "u2"] },
        },
        { signal: expect.any(AbortSignal) },
      );
    });

    test("holds the roster still while saving, so what is saved is what was shown", async () => {
      let answer!: (group: unknown) => void;
      const changeGroup = vi.fn(() => new Promise((resolve) => (answer = resolve)));
      renderGroup(changeGroup);

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() => expect(changeGroup).toHaveBeenCalled());
      // In a disabled fieldset, which browsers, unlike happy-dom, apply to each control.
      const held = (name: string) =>
        screen.getByRole("button", { name }).closest("fieldset[disabled]") !== null;
      for (const name of ["Add teachers", "Add learners", "Remove Lou Learner"]) {
        expect(held(name)).toBe(true);
      }
      answer(sevenB);
      await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
      expect(held("Add learners")).toBe(false);
    });

    test("takes a rename made meanwhile, never sending back a name nobody typed", async () => {
      let stored = sevenB;
      const changeGroup = vi.fn(async () => {
        stored = { ...sevenB, name: "7B · Angielski", learners: [person("u3", "Lou Learner")] };
        return stored;
      });
      renderGroup(changeGroup, () => stored);

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
          "value",
          "7B · Angielski",
        ),
      );
      expect(changeGroup).toHaveBeenCalledWith(
        { organizationId: "org-1", groupId: "g2", remove: { userIds: ["u2"] } },
        { signal: expect.any(AbortSignal) },
      );
    });

    test("keeps the focus on a person whose role changes, in their new section", async () => {
      renderGroup(vi.fn());

      fireEvent.click(
        await screen.findByRole("button", { name: "Change to teacher: Lou Learner" }),
      );
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Change to learner: Lou Learner" }),
        ),
      );
    });

    test("keeps the form's changes when reloading the group fails, saying so", async () => {
      let reads = 0;
      const listGroups = async () => {
        reads += 1;
        if (reads > 1) throw new TypeError("Failed to fetch");
        return [sevenB];
      };
      renderAt("/example/settings/groups/g2", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups,
          changeGroup: async () => Promise.reject(new TypeError("Failed to fetch")),
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Reload the group" }));

      await vi.waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("Could not reload the group."),
      );
      // The same form, its change still there.
      expect(screen.getByRole("heading", { name: "7B · English" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove Lee Learner" })).toBeNull();
    });

    test("reloads the group on a conflicting role, keeping the change made", async () => {
      let stored = sevenB;
      const changeGroup = vi.fn(async () => {
        stored = { ...sevenB, teachers: [...sevenB.teachers, person("u4", "Ana Teacher")] };
        throw new BraivoError(409, "Braivo answered 409.");
      });
      const { listGroups } = renderGroup(changeGroup, () => stored);

      fireEvent.click(
        await screen.findByRole("button", { name: "Change to teacher: Lou Learner" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Someone changed this group meanwhile",
      );
      expect(listGroups).toHaveBeenCalledTimes(2);
      // The group as it now stands, with the change still to save.
      expect(screen.getByText("Ana Teacher")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Change to learner: Lou Learner" })).toBeTruthy();
    });

    /** A member in no group yet. */
    const alex = { userId: "u4", name: "Alex Member", roles: ["member"] };

    test("shows whom someone else added in the other role meanwhile, leaving that addition out", async () => {
      let stored: typeof sevenB = sevenB;
      const changeGroup = vi.fn(async () => {
        // Alex, added as a learner by someone else first; the form adds them as a teacher.
        stored = { ...sevenB, learners: [...sevenB.learners, person("u4", "Alex Member")] };
        throw new BraivoError(409, "Braivo answered 409.");
      });
      renderGroup(changeGroup, () => stored, [...people, alex]);

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Add teachers" }));
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Alex" } });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Alex Member is already in it in the other role");
      // As they now are, a learner, the role change theirs to make; the rest kept.
      expect(screen.getByRole("button", { name: "Change to teacher: Alex Member" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove Lee Learner" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() => expect(changeGroup).toHaveBeenCalledTimes(2));
      expect(changeGroup).toHaveBeenLastCalledWith(
        { organizationId: "org-1", groupId: "g2", remove: { userIds: ["u2"] } },
        { signal: expect.any(AbortSignal) },
      );
    });

    test("names a conflict found by reloading after a reload that failed", async () => {
      let stored: typeof sevenB = sevenB;
      let reads = 0;
      const listGroups = vi.fn(async () => {
        reads += 1;
        if (reads === 2) throw new TypeError("Failed to fetch");
        return [stored];
      });
      renderAt("/example/settings/groups/g2", {
        braivo: {
          listMembers: async () => [
            ...people,
            { userId: "u4", name: "Alex Member", roles: ["member"] },
          ],
          listCourses: async () => [beginners],
          listGroups,
          changeGroup: async () => {
            stored = { ...sevenB, learners: [...sevenB.learners, person("u4", "Alex Member")] };
            throw new BraivoError(409, "Braivo answered 409.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Add teachers" }));
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Alex" } });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Reload the group" }));

      await vi.waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Alex Member is already in it in the other role",
        ),
      );
      expect(screen.getByRole("button", { name: "Change to teacher: Alex Member" })).toBeTruthy();
    });

    test("never carries an undone change onto a reloaded group", async () => {
      let stored: typeof sevenB = sevenB;
      const changeGroup = vi.fn(async () => {
        // Landed, its answer lost; then someone else removed Lee and the course.
        stored = {
          ...sevenB,
          name: "7B · Angielski",
          learners: [person("u3", "Lou Learner")],
          courses: [],
        };
        throw new TypeError("Failed to fetch");
      });
      renderGroup(changeGroup, () => stored, [...people, alex]);

      // Lee to teacher and back, the course out and back, the name and back: all undone.
      fireEvent.click(
        await screen.findByRole("button", { name: "Change to teacher: Lee Learner" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Change to learner: Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove Beginners" }));
      fireEvent.click(screen.getByRole("button", { name: "Add courses" }));
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Beginners" } });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      const name = screen.getByRole("textbox", { name: "Name" });
      fireEvent.change(name, { target: { value: "7B" } });
      fireEvent.change(name, { target: { value: "7B · English " } });
      fireEvent.click(screen.getByRole("button", { name: "Remove Lou Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(changeGroup).toHaveBeenCalledWith(
        { organizationId: "org-1", groupId: "g2", remove: { userIds: ["u3"] } },
        { signal: expect.any(AbortSignal) },
      );

      fireEvent.click(await screen.findByRole("button", { name: "Reload the group" }));
      await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      // Neither Lee, the course, nor the old name comes back: only removing Lou is still to save.
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
        "value",
        "7B · Angielski",
      );
      expect(screen.queryByText("Lee Learner")).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove Beginners" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() => expect(changeGroup).toHaveBeenCalledTimes(2));
      expect(changeGroup).toHaveBeenLastCalledWith(
        { organizationId: "org-1", groupId: "g2", remove: { userIds: ["u3"] } },
        { signal: expect.any(AbortSignal) },
      );
    });

    test("keeps an unconfirmed change's alert, and its reload, while the form is edited", async () => {
      renderGroup(async () => Promise.reject(new TypeError("Failed to fetch")));

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("button", { name: "Reload the group" });
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "7C" } });

      expect(screen.getByRole("button", { name: "Reload the group" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save changes" }).getAttribute("aria-disabled"),
      ).toBe("true");
    });

    test("names the group by its new name in the tab once renamed", async () => {
      let stored: typeof sevenB = sevenB;
      renderGroup(
        async () => (stored = { ...sevenB, name: "7C · English" }),
        () => stored,
      );
      await vi.waitFor(() => expect(document.title).toContain("7B · English"));

      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "7C · English" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByRole("heading", { name: "7C · English" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toContain("7C · English"));
    });

    test("holds saving until a conflict's reload finishes", async () => {
      let reads = 0;
      let answer!: (groups: unknown) => void;
      const changeGroup = vi.fn(async () =>
        Promise.reject(new BraivoError(409, "Braivo answered 409.")),
      );
      renderAt("/example/settings/groups/g2", {
        braivo: {
          listMembers: async () => people,
          listCourses: async () => [beginners],
          listGroups: () =>
            (reads += 1) === 1
              ? Promise.resolve([sevenB])
              : new Promise((resolve) => (answer = resolve)),
          changeGroup,
        },
      });

      fireEvent.click(
        await screen.findByRole("button", { name: "Change to teacher: Lou Learner" }),
      );
      const save = screen.getByRole("button", { name: "Save changes" });
      fireEvent.click(save);
      await vi.waitFor(() => expect(reads).toBe(2));
      expect(save.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(save);
      expect(changeGroup).toHaveBeenCalledTimes(1);

      answer([sevenB]);
      await vi.waitFor(() => expect(save.getAttribute("aria-disabled")).toBe("false"));
    });

    test("never sends an unconfirmed change again by itself, offering to reload instead", async () => {
      const changeGroup = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
      const { listGroups } = renderGroup(changeGroup);

      fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Learner" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not confirm the change.",
      );
      // Saving again first asks for the reload, sending nothing.
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("Reload the group to check it"),
      );
      expect(changeGroup).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Reload the group" }));
      await vi.waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.waitFor(() => expect(changeGroup).toHaveBeenCalledTimes(2));
      // Still removed in the form, to save again once checked.
      expect(screen.queryByRole("button", { name: "Remove Lee Learner" })).toBeNull();
    });
  });
});
