// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import type { Activity, BraivoClient } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS } from "../lib/deadline.ts";
import { SPANISH_ID, activity } from "./fixtures.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

/** `text`, as a screen reader reads it: a count's no-break spaces as spaces. */
function spaced(text: string) {
  return (description: string) => description.replace(/\s/gu, " ") === text;
}

/** Nothing practice would offer now. */
const nothingWaits = { learning: 0, dueForReview: 0, new: 0 };

describe("the learn app", () => {
  test("says on each course what waits there now, or that nothing does, from one read", async () => {
    const spanish = { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" };
    const frenchCourse = { id: "c2", number: 4733, title: "French", urlLabel: "french" };
    const empty = { id: "c3", number: 4734, title: "German", urlLabel: "german" };
    const { learnerCoursesWithStanding } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [frenchCourse, empty, spanish],
      learnerCoursesWithStanding: async () => [
        {
          ...frenchCourse,
          standing: { retained: 0, dueForReview: 2, learning: 0, notStarted: 1 },
          waiting: { learning: 0, dueForReview: 2, new: 1 },
        },
        {
          ...empty,
          standing: { retained: 0, dueForReview: 0, learning: 0, notStarted: 0 },
          waiting: nothingWaits,
        },
        {
          ...spanish,
          standing: { retained: 3, dueForReview: 1, learning: 1, notStarted: 0 },
          waiting: nothingWaits,
        },
      ],
    });

    // Named by the title, the line its description.
    const french = await screen.findByRole("link", {
      name: "French",
      description: spaced("2 to review · 1 new"),
    });
    // Due and learning, yet resting: nothing recommended now, not nothing due.
    // Why is the course page's to say.
    expect(
      screen.getByRole("link", {
        name: "Spanish",
        description: "No recommended practice right now",
      }),
    ).toBeTruthy();
    // Nothing to practise ever: the title alone.
    expect(screen.getByRole("link", { name: "German", description: "" })).toBeTruthy();
    // Where the learner stands shows where practice pauses, not here.
    expect(french.querySelector(".rounded-full")).toBeNull();
    expect(learnerCoursesWithStanding).toHaveBeenCalledOnce();
  });

  test("leads with the course where something waits, saying what, one tap from practice", async () => {
    const caughtUp = { id: "c1", number: 4731, title: "Arabic", urlLabel: "arabic" };
    const due = { id: "c2", number: 4732, title: "Spanish", urlLabel: "spanish" };
    const { router } = renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [caughtUp, due],
      learnerCoursesWithStanding: async () => [
        {
          ...caughtUp,
          standing: { retained: 3, dueForReview: 0, learning: 0, notStarted: 0 },
          waiting: nothingWaits,
        },
        {
          ...due,
          standing: { retained: 1, dueForReview: 2, learning: 0, notStarted: 0 },
          waiting: { learning: 0, dueForReview: 2, new: 0 },
        },
      ],
      nextActivity: async () => activity,
    });

    const lead = await screen.findByRole("link", {
      name: "Spanish",
      description: spaced("2 to review"),
    });
    const cards = screen.getAllByRole("link", { name: /Arabic|Spanish/ });
    expect(cards).toHaveLength(2);
    expect(cards[0]).toBe(lead);
    // The learner stays free to open the other, which claims nothing.
    expect(
      screen.getByRole("link", {
        name: "Arabic",
        description: "No recommended practice right now",
      }),
    ).toBeTruthy();

    fireEvent.click(lead);
    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/c/4732-spanish");
  });

  test("says everything practice would offer, in its order, and keeps the list's order among those that wait", async () => {
    const list = ["Arabic", "French", "German", "Spanish"].map((title, index) => ({
      id: `c${index}`,
      number: 4730 + index,
      title,
      urlLabel: title.toLowerCase(),
    }));
    const [arabic, french, german, spanish] = list as [
      (typeof list)[number],
      (typeof list)[number],
      (typeof list)[number],
      (typeof list)[number],
    ];
    renderAt("/", {
      signedIn: true,
      learnerCourses: async () => list,
      learnerCoursesWithStanding: async () => [
        {
          ...arabic,
          standing: { retained: 2, dueForReview: 0, learning: 0, notStarted: 0 },
          waiting: nothingWaits,
        },
        {
          ...french,
          standing: { retained: 0, dueForReview: 2, learning: 1, notStarted: 3 },
          waiting: { learning: 1, dueForReview: 2, new: 3 },
        },
        {
          ...german,
          standing: { retained: 2, dueForReview: 0, learning: 0, notStarted: 0 },
          waiting: nothingWaits,
        },
        {
          ...spanish,
          standing: { retained: 1, dueForReview: 0, learning: 0, notStarted: 2 },
          waiting: { learning: 0, dueForReview: 0, new: 2 },
        },
      ],
    });

    await screen.findByRole("link", {
      name: "French",
      description: spaced("1 to practise · 2 to review · 3 new"),
    });
    expect(
      screen.getByRole("link", {
        name: "Spanish",
        description: spaced("2 new"),
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("main"))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/c/c1", "/c/c3", "/c/c0", "/c/c2"]);
  });

  test("leads with reviews or learning over a course offering only new material, whose title sorts first", async () => {
    const list = ["Arabic", "Basque", "Czech", "Dutch", "Estonian"].map((title, index) => ({
      id: `c${index}`,
      number: 4730 + index,
      title,
      urlLabel: title.toLowerCase(),
    }));
    const waiting = [
      { ...nothingWaits, new: 3 },
      nothingWaits,
      { ...nothingWaits, dueForReview: 2 },
      { ...nothingWaits, new: 1 },
      { ...nothingWaits, learning: 1 },
    ];
    renderAt("/", {
      signedIn: true,
      learnerCourses: async () => list,
      learnerCoursesWithStanding: async () =>
        list.map((course, index) => ({
          ...course,
          standing: { retained: 1, dueForReview: 0, learning: 0, notStarted: 0 },
          waiting: waiting[index]!,
        })),
    });

    await screen.findByRole("link", { name: "Czech" });
    expect(
      within(screen.getByRole("main"))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/c/c2", "/c/c4", "/c/c0", "/c/c3", "/c/c1"]);
  });

  test("says what waits in a course not started like any other, and nothing past the day's limit", async () => {
    const list = ["Arabic", "French", "German"].map((title, index) => ({
      id: `c${index}`,
      number: 4730 + index,
      title,
      urlLabel: title.toLowerCase(),
    }));
    const [fresh, atLimit, noTasks] = list as [
      (typeof list)[number],
      (typeof list)[number],
      (typeof list)[number],
    ];
    const notStarted = { retained: 0, dueForReview: 0, learning: 0, notStarted: 4 };
    renderAt("/", {
      signedIn: true,
      learnerCourses: async () => list,
      learnerCoursesWithStanding: async () => [
        { ...fresh, standing: notStarted, waiting: { ...nothingWaits, new: 4 } },
        { ...atLimit, standing: notStarted, waiting: nothingWaits },
        { ...noTasks, standing: notStarted, waiting: nothingWaits },
      ],
    });

    expect(
      await screen.findByRole("link", { name: "Arabic", description: spaced("4 new") }),
    ).toBeTruthy();
    // Whether at the day's limit or with nothing written yet: no question follows a tap.
    for (const name of ["French", "German"]) {
      expect(
        screen.getByRole("link", { name, description: "No recommended practice right now" }),
      ).toBeTruthy();
    }
  });

  test("lists the courses by title, claiming nothing, when standings are not read within their deadline", async () => {
    vi.useFakeTimers();
    renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [
        { id: "c1", number: 4731, title: "French", urlLabel: "french" },
        { id: "c2", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      learnerCoursesWithStanding: (options) => stall(options),
    });
    await waitOut(OPTIONAL_READ_DEADLINE_MS);
    vi.useRealTimers();

    const french = await screen.findByRole("link", { name: "French", description: "" });
    const spanish = screen.getByRole("link", { name: "Spanish", description: "" });
    expect(screen.getAllByRole("link", { name: /French|Spanish/ })).toEqual([french, spanish]);
  });

  describe("back from practice", () => {
    const arabic = { id: "c0", number: 4731, title: "Arabic", urlLabel: "arabic" };
    const spanish = { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" };
    const read = (due: typeof arabic) =>
      [arabic, spanish].map((course) => ({
        ...course,
        standing: { retained: 1, dueForReview: 1, learning: 0, notStarted: 0 },
        waiting: course === due ? { learning: 0, dueForReview: 1, new: 0 } : nothingWaits,
      }));

    /** Home with Spanish due, then into its practice; the list read again by `reread`. */
    async function practiseSpanish(reread: BraivoClient["learnerCoursesWithStanding"]) {
      let reads = 0;
      const rendered = renderAt("/", {
        signedIn: true,
        hostOrganization: async () => ({ name: "Fernwood" }),
        learnerCourses: async () => [arabic, spanish],
        learnerCoursesWithStanding: async (options) =>
          reads++ === 0 ? read(spanish) : reread(options),
        nextActivity: async () => activity,
      });
      fireEvent.click(await screen.findByRole("link", { name: "Spanish", description: /review/ }));
      expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
      return rendered;
    }

    /** The cards in order, once shown. */
    async function cards() {
      await screen.findByRole("heading", { name: "Your courses" });
      return screen
        .getAllByRole("link", { name: /Arabic|Spanish/ })
        .map((link) => link.textContent);
    }

    // What was read before practice is stale: shown, then reread, the cards would
    // move under the learner's tap. So the list waits for its fresh read.
    test.each([
      ["Close", () => fireEvent.click(screen.getByRole("link", { name: "Close" }))],
      ["Back", (router: { history: { back: () => void } }) => router.history.back()],
    ])("by %s, shows the list only as read again", async (_, leave) => {
      const held = Promise.withResolvers<ReturnType<typeof read>>();
      const { router, learnerCoursesWithStanding } = await practiseSpanish(() => held.promise);

      leave(router);
      await vi.waitFor(() => expect(learnerCoursesWithStanding).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("heading", { name: "Your courses" })).toBeNull();

      held.resolve(read(arabic));
      expect(await cards()).toEqual([
        expect.stringContaining("Arabic"),
        expect.stringContaining("Spanish"),
      ]);
    });

    test("past the reread's deadline, shows the list by title, claiming nothing", async () => {
      const { learnerCoursesWithStanding } = await practiseSpanish(stall);
      vi.useFakeTimers();

      fireEvent.click(screen.getByRole("link", { name: "Close" }));
      // Not `vi.waitFor`, which would move the faked clock on.
      await waitOut(0);
      expect(learnerCoursesWithStanding).toHaveBeenCalledTimes(2);
      await waitOut(OPTIONAL_READ_DEADLINE_MS - 1);
      expect(screen.queryByRole("heading", { name: "Your courses" })).toBeNull();
      await waitOut(1);
      vi.useRealTimers();

      expect(await cards()).toEqual(["Arabic", "Spanish"]);
      expect(screen.getByRole("link", { name: "Spanish", description: "" })).toBeTruthy();
    });
  });

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
      // Not practice: the account's header, to sign out and in as another.
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

  test("shows that a page slow to load is on its way", async () => {
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
    loading.resolve(activity);
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });
});
