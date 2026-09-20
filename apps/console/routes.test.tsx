// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError, type KnowledgeReport } from "@braivo/server/client";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { routeTree } from "./routeTree.gen.ts";

afterEach(cleanup);

const members = [
  { id: "m1", userId: "u1", role: "owner", user: { name: "Olive Owner" } },
  { id: "m2", userId: "u2", role: "member", user: { name: "Lee Learner" } },
];

/**
 * The console as an owner reaches it, under the base path it is served from,
 * with Braivo and Better Auth stubbed. The route tree is the real one.
 */
function renderAt(
  path: string,
  stubs: { signedIn?: boolean; braivo?: object; listMembers?: () => Promise<unknown> } = {},
) {
  let signedIn = stubs.signedIn ?? true;
  const auth = {
    getSession: async () => ({
      data: signedIn ? { user: { name: "Olive Owner" } } : null,
      error: null,
    }),
    signIn: {
      email: vi.fn(async () => {
        signedIn = true;
        return { error: null };
      }),
    },
    organization: {
      list: async () => ({ data: [{ id: "org-1", name: "Example School" }], error: null }),
      listMembers:
        stubs.listMembers ??
        (async () => ({ data: { members, total: members.length }, error: null })),
    },
  };

  const router = createRouter({
    routeTree,
    basepath: "/console/",
    history: createMemoryHistory({ initialEntries: [path] }),
    context: {
      auth: auth as unknown as AppContext["auth"],
      braivo: (stubs.braivo ?? {}) as AppContext["braivo"],
    },
  });
  render(<RouterProvider router={router} />);

  return { auth, router };
}

describe("the console", () => {
  test("returns an owner to the page they asked for once they sign in", async () => {
    const { auth, router } = renderAt("/console/organizations/org-1", {
      signedIn: false,
      braivo: { listCourses: async () => [] },
    });

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.signIn.email).toHaveBeenCalledWith({
      email: "owner@example.com",
      password: "correct horse battery",
    });
    expect(router.history.location.pathname).toBe("/console/organizations/org-1");
  });

  test("lists the organizations the owner is in", async () => {
    renderAt("/console/");

    const link = await screen.findByRole("link", { name: "Example School" });
    expect(link.getAttribute("href")).toBe("/console/organizations/org-1");
  });

  test("labels the organization form, and tells what a slug may hold", async () => {
    renderAt("/console/");

    expect(await screen.findByLabelText("Organization name")).toBeTruthy();
    expect(screen.getByLabelText("Slug").getAttribute("aria-describedby")).toBe(
      screen.getByText("Lowercase letters, digits, and hyphens.").id,
    );
  });

  test("reads an organization Braivo refuses as not found", async () => {
    renderAt("/console/organizations/org-1", {
      braivo: {
        listCourses: async () => {
          throw new BraivoError(403, "forbidden");
        },
      },
    });

    expect(
      await screen.findByText("This organization does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("reads a course its organization does not list as not found", async () => {
    renderAt("/console/organizations/org-1/courses/elsewhere", {
      braivo: { listCourses: async () => [{ id: "course-1", title: "Beginners" }] },
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("asks nothing scoped to a course before that course is the organization's", async () => {
    const learnerProgress = vi.fn();
    const listObjectives = vi.fn();
    const listMembers = vi.fn(async () => ({
      data: { members, total: members.length },
      error: null,
    }));
    renderAt("/console/organizations/org-1/courses/elsewhere/learners/u2", {
      braivo: {
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
        learnerProgress,
        listObjectives,
      },
      listMembers,
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
    // An owner of both organizations could read this report; what they may not
    // do is pair it with another organization's objectives and roster.
    expect({
      learnerProgress: learnerProgress.mock.calls,
      listObjectives: listObjectives.mock.calls,
      listMembers: listMembers.mock.calls,
    }).toEqual({ learnerProgress: [], listObjectives: [], listMembers: [] });
  });

  test("asks nothing about the organization's roster until the course is its own", async () => {
    const listMembers = vi.fn(async () => ({
      data: { members, total: members.length },
      error: null,
    }));
    renderAt("/console/organizations/org-1/courses/elsewhere", {
      braivo: { listCourses: async () => [{ id: "course-1", title: "Beginners" }] },
      listMembers,
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
    expect(listMembers.mock.calls).toEqual([]);
  });

  test("reads a course as not found when Better Auth refuses its organization", async () => {
    // `readMembers` converts Better Auth's own refusal, which `orNotFound` never
    // sees: without this the roster's 403 would surface as an error page.
    renderAt("/console/organizations/org-1/courses/course-1", {
      braivo: { listCourses: async () => [{ id: "course-1", title: "Beginners" }] },
      listMembers: async () => ({ data: null, error: { status: 403, message: "Forbidden" } }),
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("links each member of a course's organization to their progress", async () => {
    renderAt("/console/organizations/org-1/courses/course-1", {
      braivo: { listCourses: async () => [{ id: "course-1", title: "Beginners" }] },
    });

    expect(await screen.findByRole("heading", { name: "Beginners" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Lee Learner" }).getAttribute("href")).toBe(
      "/console/organizations/org-1/courses/course-1/learners/u2",
    );
  });

  test("shows where a learner stands on each objective, by title", async () => {
    const report: KnowledgeReport = {
      modelVersion: "v1",
      objectives: [
        {
          objectiveId: "o1",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 1,
          retrievability: 0.42,
          due: true,
        },
        { objectiveId: "o2", phase: "unseen" },
      ],
    };
    const learnerProgress = vi.fn(async () => report);
    const listCourses = vi.fn(async () => [{ id: "course-1", title: "Beginners" }]);
    const listObjectives = vi.fn(async () => [
      { id: "o1", title: "Greetings" },
      { id: "o2", title: "Numbers" },
    ]);
    const listMembers = vi.fn(async () => ({
      data: { members, total: members.length },
      error: null,
    }));
    renderAt("/console/organizations/org-1/courses/course-1/learners/u2", {
      braivo: { learnerProgress, listCourses, listObjectives },
      listMembers,
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    const [, greetings, numbers] = screen.getAllByRole("row");
    expect(within(greetings!).getByText("Greetings")).toBeTruthy();
    expect(within(greetings!).getByText("Due for review, 42% recall")).toBeTruthy();
    expect(within(numbers!).getByText("Not started")).toBeTruthy();
    // Every id here is an interchangeable string, so a read scoped to the wrong
    // one type-checks; these assertions are what hold the tenant boundary.
    const options = { signal: expect.any(AbortSignal) };
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "course-1", learnerId: "u2" },
      options,
    );
    expect(listCourses).toHaveBeenCalledWith("org-1", options);
    expect(listObjectives).toHaveBeenCalledWith("org-1", options);
    expect(listMembers).toHaveBeenCalledWith({ query: { organizationId: "org-1" } });
  });

  test("reads progress Braivo will not show as not found", async () => {
    renderAt("/console/organizations/org-1/courses/course-1/learners/u9", {
      braivo: {
        learnerProgress: async () => {
          throw new BraivoError(404, "not found");
        },
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
        listObjectives: async () => [],
      },
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
  });
});
