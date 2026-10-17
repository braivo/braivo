// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Activity, BraivoClient } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { READ_DEADLINE_MS } from "../lib/deadline.ts";
import { SPANISH_ID, activity } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

describe("the learn app", () => {
  test("lists the learner's courses, each a way into it by its number", async () => {
    const { learnerCourses, router } = renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: async () => activity,
    });

    const link = await screen.findByRole("link", { name: "Spanish" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(learnerCourses).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    fireEvent.click(link);

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/c/4732-spanish");
  });

  test("leads into a course by its ID where no organization's domain is known", async () => {
    const { nextActivity, router } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [
        { id: SPANISH_ID, number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: async () => activity,
    });

    fireEvent.click(await screen.findByRole("link", { name: "Spanish" }));

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/c/${SPANISH_ID}`);
    expect(nextActivity).toHaveBeenCalledWith(SPANISH_ID, { signal: expect.any(AbortSignal) });
  });

  test("replaces a label changed since the link was sent, before asking anything else, and Back skips it", async () => {
    const { router, learnerCourseByNumber, nextActivity, submitAttempt } = renderAt("/", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    await screen.findByText("No courses yet");

    await router.navigate({ to: "/c/$courseRef", params: { courseRef: "4732-hiszpański" } });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/c/4732-spanish");
    expect(learnerCourseByNumber).toHaveBeenCalledTimes(2);
    expect(nextActivity).toHaveBeenCalledTimes(1);
    expect(submitAttempt).not.toHaveBeenCalled();
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  test("replaces a label typed decomposed, once, with the composed one", async () => {
    const { router, learnerCourseByNumber, nextActivity } = renderAt("/c/4732-espan%CC%83ol", {
      signedIn: true,
      learnerCourseByNumber: async (number) => ({
        id: "c1",
        number,
        title: "Español",
        urlLabel: "español",
      }),
      nextActivity: async () => activity,
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/c/4732-espa\u00f1ol");
    expect(learnerCourseByNumber).toHaveBeenCalledTimes(2);
    expect(nextActivity).toHaveBeenCalledTimes(1);
  });

  test.each(["/c/4732", "/c/4732-spanish"])("leaves %s as it is", async (path) => {
    const { router, learnerCourseByNumber } = renderAt(path, {
      signedIn: true,
      nextActivity: async () => activity,
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe(path);
    expect(learnerCourseByNumber).toHaveBeenCalledTimes(1);
  });

  test.each(["/c/1234", "/c/04732", "/c/4732-", "/c/c1"])(
    "reads %s, which names none of the learner's courses, as not found",
    async (path) => {
      const { nextActivity } = renderAt(path, { signedIn: true });

      // Said alike for a course on another account, with how to recover.
      const notice = await screen.findByRole("region", {
        name: "This course does not exist, or is not one of yours.",
        description:
          "If someone sent you a link to it, check that you are signed in with the right account, or ask them for access.",
      });
      expect(within(notice).getByRole("link", { name: "Your courses" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
      expect(nextActivity).not.toHaveBeenCalled();
    },
  );

  test("tells a learner with no courses so, under the page's heading", async () => {
    renderAt("/", { signedIn: true });

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Your courses" })).toBeTruthy();
  });

  test("leads from a path that names nothing back to the courses", async () => {
    renderAt("/elsewhere", { signedIn: true, learnerCourses: async () => [] });

    await screen.findByRole("region", { name: "There is nothing here." });
    fireEvent.click(screen.getByRole("link", { name: "Your courses" }));

    expect(await screen.findByText("No courses yet")).toBeTruthy();
  });

  test("offers to load the course list again when loading it failed", async () => {
    const learnerCourses = vi
      .fn<BraivoClient["learnerCourses"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([{ id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" }]);
    renderAt("/", { signedIn: true, learnerCourses });

    const notice = await screen.findByRole("region", { name: "Your courses could not be loaded." });
    expect(document.activeElement).toBe(notice);
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("offers to load the course list again when Braivo does not answer in time", async () => {
    let answering = false;
    vi.useFakeTimers();
    renderAt("/", {
      signedIn: true,
      learnerCourses: (options) =>
        answering
          ? Promise.resolve([{ id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" }])
          : stall(options),
    });
    await waitOut(READ_DEADLINE_MS - 1);
    expect(screen.queryByRole("region", { name: "Your courses could not be loaded." })).toBeNull();
    await waitOut(1);
    vi.useRealTimers();

    answering = true;
    const notice = await screen.findByRole("region", { name: "Your courses could not be loaded." });
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("shows that a page slow to load is on its way, under the header", async () => {
    const loading = Promise.withResolvers<Activity | undefined>();
    renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: () => loading.promise,
    });
    fireEvent.click(await screen.findByRole("link", { name: "Spanish" }));

    expect(await screen.findByRole("status", { name: "Loading" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    loading.resolve(activity);
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });
});
