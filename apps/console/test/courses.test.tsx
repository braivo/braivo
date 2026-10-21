// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { members, courseProgress, school, annex, beginners, readCourse } from "./fixtures.ts";
import { stall, waitOut, renderAt, expectAiAppGuide } from "./render.tsx";

describe("the console", () => {
  test("leads from an organization to its sources", async () => {
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    expect((await screen.findByRole("link", { name: "Sources" })).getAttribute("href")).toBe(
      "/example/sources",
    );
    // With no course yet, the empty list offers them, and nothing else does.
    expect(screen.getByRole("link", { name: "Open Sources" }).getAttribute("href")).toBe(
      "/example/sources",
    );
    expect(screen.queryByRole("link", { name: "Add material" })).toBeNull();
    expect(screen.getByText(/draft a course from it there/)).toBeTruthy();
    expectAiAppGuide();
  });

  test("promises no drafting in the console, with no course yet, where Braivo's AI is off", async () => {
    renderAt("/example", {
      organizations: [{ ...school, aiEnabled: false }],
      braivo: { listCourses: async () => [] },
    });

    const said = await screen.findByText(/off for this organization/);
    expect(said.textContent).toMatch(
      /ask whoever runs Braivo.*your own AI app, such as Claude or ChatGPT/,
    );
    expectAiAppGuide(said);
    expect(screen.queryByText(/draft a course from it there/)).toBeNull();
  });

  test("still leads an owner with courses to where a new one starts, its material", async () => {
    renderAt("/example", {
      braivo: {
        listCourses: async () => [{ id: "c1", title: "Spanish", published: true }],
        listSources: async () => [],
      },
    });

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
    // To the form itself, past the sources listed above it.
    expect(screen.getByRole("link", { name: "Add material" }).getAttribute("href")).toBe(
      "/example/sources#add-material",
    );
    expect(screen.queryByRole("link", { name: "Open Sources" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Add material" }));
    expect((await screen.findByRole("form", { name: "Add material" })).id).toBe("add-material");
  });

  test("marks a course hidden, or pending review, or a published course's tasks, in the list", async () => {
    // The courses' own counts, which count a shared objective's tasks in each,
    // are not what the list says: each task is listed once.
    const listed = { published: true, hidden: false, pendingTaskCount: 9 };
    const objective = { courseIds: [], pendingTaskCount: 0 };
    renderAt("/example", {
      braivo: {
        listCourses: async () => [
          { ...listed, id: "c1", number: 1001, title: "Spanish", urlLabel: "spanish" },
          {
            ...listed,
            id: "c2",
            number: 1002,
            title: "French",
            urlLabel: "french",
            published: false,
          },
          { ...listed, id: "c3", number: 1003, title: "German", urlLabel: "german", hidden: true },
        ],
        listObjectives: async () => [
          { ...objective, id: "o1", title: "Cases", courseIds: ["c3"], pendingTaskCount: 2 },
          { ...objective, id: "o2", title: "Umlauts", courseIds: ["c3"], pendingTaskCount: 1 },
          { ...objective, id: "o3", title: "Greetings", courseIds: ["c1"] },
          {
            ...objective,
            id: "o4",
            title: "Numbers",
            courseIds: ["c2", "c3"],
            pendingTaskCount: 4,
          },
          { ...objective, id: "o5", title: "Colours", pendingTaskCount: 1 },
          { ...objective, id: "o6", title: "Weather" },
        ],
      },
    });

    const french = (await screen.findByRole("link", { name: "French (needs review)" })).closest(
      "li",
    )!;
    expect(french.textContent).toContain("Needs review");
    // Heard once, in the link's name, not again from the badge.
    expect(within(french).getByText("Needs review").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("link", { name: "Spanish" }).closest("li")!.textContent).toBe(
      "Spanish",
    );
    // A published course's new tasks, counted: those of its objectives in no
    // other course; hidden from learners, said first.
    const german = screen
      .getByRole("link", { name: "German (hidden, 3 tasks need review)" })
      .closest("li")!;
    expect(german.textContent).toBe(
      "German (hidden, 3 tasks need review)Hidden3 tasks need review",
    );
    expect(within(german).getByText("Hidden").getAttribute("aria-hidden")).toBe("true");
    expect(within(german).getByText("3 tasks need review").getAttribute("aria-hidden")).toBe(
      "true",
    );
    // A shared objective's, and one in no course, under the objective instead.
    const objectives = within(screen.getByRole("region", { name: "Other objectives" }));
    expect(objectives.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Numbers (4 tasks need review)4 tasks need reviewIn 2 courses",
      "Colours (1 task needs review)1 task needs reviewIn no course",
      // In no course, nothing pending: listed still, as no course leads to it.
      "WeatherIn no course",
    ]);
    // Where it is, the link's description, not part of its name.
    expect(
      objectives
        .getByRole("link", { name: "Colours (1 task needs review)", description: "In no course" })
        .getAttribute("href"),
    ).toBe("/example/objectives/o5");
  });

  test("fails the page, to try again, when its objectives are not answered in time", async () => {
    vi.useFakeTimers();
    renderAt("/example", {
      braivo: {
        listCourses: async () => [],
        listObjectives: (_id: string, options?: { signal?: AbortSignal }) => stall(options),
      },
    });
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("lists no other objective while every one is in a course of its own", async () => {
    renderAt("/example", {
      braivo: {
        listCourses: async () => [
          { id: "c1", number: 1001, title: "Spanish", urlLabel: "spanish", published: true },
        ],
        listObjectives: async () => [
          { id: "o1", title: "Greetings", courseIds: ["c1"], pendingTaskCount: 2 },
        ],
      },
    });

    expect(await screen.findByRole("link", { name: "Spanish (2 tasks need review)" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Other objectives" })).toBeNull();
  });

  test("says where an organization's learners practise, or that they have nowhere yet", async () => {
    renderAt("/example", { braivo: { listCourses: async () => [] } });
    const site = await screen.findByRole("link", { name: "example.braivo.app" });
    expect(site.getAttribute("href")).toBe("https://example.braivo.app");
    expect(site.getAttribute("target")).toBe("_blank");
    expect(site.getAttribute("rel")).toBe("noreferrer");
    expect(site.parentElement?.textContent).toBe("Learners practise at example.braivo.app.");
    cleanup();

    renderAt("/annex", { organizations: [annex], braivo: { listCourses: async () => [] } });
    expect(
      await screen.findByText(
        "Learners have no site to practise on yet. Ask whoever set Braivo up for you to add one.",
      ),
    ).toBeTruthy();
  });

  test("copies the learners' address, saying so, or that it could not", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    onTestFinished(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    });
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://example.braivo.app");
    expect(screen.getByRole("status").textContent).toBe("Copied.");

    // Refused, as outside a secure context or without permission.
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    const refused = await screen.findByRole("alert");
    expect(refused.textContent).toBe("Could not copy. Select it instead.");
    expect(screen.getByRole("status").textContent).toBe("");
    // Refused again: a new alert, so it is announced again.
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(refused));
    // Then copied: the alert goes.
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(4);

    // No clipboard at all, as over plain HTTP: refused before any await.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    const missing = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(missing));
  });

  test("on the dev server, links to and copies a .localhost learn domain at the learn app's port", async () => {
    vi.stubEnv("BRAIVO_LEARN_PORT", "5199");
    onTestFinished(() => void vi.unstubAllEnvs());
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    onTestFinished(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    });
    const local = { ...school, learnDomain: "example.localhost" };
    renderAt("/example/courses/course-1", { organizations: [local], braivo: { readCourse } });

    // The organization's hostname and the course's reference kept, over HTTP.
    const url = "http://example.localhost:5199/c/4732-beginners";
    const site = await screen.findByRole("link", {
      name: "example.localhost:5199/c/4732-beginners",
    });
    expect(site.getAttribute("href")).toBe(url);
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(url));
    cleanup();

    renderAt("/example/settings/domains", {
      organizations: [local],
      braivo: {
        listDomains: async () => ({
          domains: [{ hostname: "example.localhost" }, { hostname: "learn.example.com" }],
          claims: [],
          canAdd: false,
        }),
      },
    });
    const domain = await screen.findByRole("link", { name: "example.localhost" });
    expect(domain.getAttribute("href")).toBe("http://example.localhost:5199");
    // Not .localhost: HTTPS, as it is not the learn app's dev server.
    expect(screen.getByRole("link", { name: "learn.example.com" }).getAttribute("href")).toBe(
      "https://learn.example.com",
    );
  });

  test("says a course is open to the organization's learners, even before they have a site", async () => {
    renderAt("/annex/courses/course-1", { organizations: [annex], braivo: { readCourse } });

    expect(
      await screen.findByText("Open to every learner in Annex, once it has a site to practise on."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  });

  test("changes the label after a course's number, showing it as it will be written", async () => {
    let stored = "beginners";
    const setCourseUrlLabel = vi.fn<BraivoClient["setCourseUrlLabel"]>(async (input) => {
      stored = input.urlLabel;
      return { saved: true };
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => ({
          ...(await readCourse(input)),
          urlLabel: stored,
        }),
        setCourseUrlLabel,
      },
    });
    const field = await screen.findByRole("textbox", { name: "Label in its link" });

    fireEvent.change(field, { target: { value: "Angielski  dla Początkujących!" } });
    expect(
      screen.getByText(
        "Its link ends /c/4732-angielski-dla-początkujących. /c/4732 alone reaches it too, short to say aloud, and links sent before keep working.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));

    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(setCourseUrlLabel).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        courseId: "course-1",
        urlLabel: "angielski-dla-początkujących",
        previous: "beginners",
      },
      { signal: expect.any(AbortSignal) },
    );
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: "example.braivo.app/c/4732-angielski-dla-początkujących" })
          .getAttribute("href"),
      ).toBe("https://example.braivo.app/c/4732-angielski-dla-początkujących"),
    );
  });

  test("keeps a label typed when someone else changed it meanwhile, replacing theirs only when saved again", async () => {
    let stored = "beginners-2026";
    const setCourseUrlLabel = vi.fn<BraivoClient["setCourseUrlLabel"]>(async (input) => {
      if (input.previous !== stored) return { saved: false, urlLabel: stored };
      stored = input.urlLabel;
      return { saved: true };
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        // Read as `beginners`, before the other change.
        readCourse,
        setCourseUrlLabel,
      },
    });
    const field = (await screen.findByRole("textbox", {
      name: "Label in its link",
    })) as HTMLInputElement;

    fireEvent.change(field, { target: { value: "spanish-a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Someone else changed it to “beginners-2026” meanwhile. Save again to replace theirs.",
    );
    expect(field.value).toBe("spanish-a1");
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(setCourseUrlLabel.mock.calls.map(([input]) => input.previous)).toEqual([
      "beginners",
      "beginners-2026",
    ]);
    // Saved again at once, over what it saved, not over the page's reload.
    fireEvent.change(field, { target: { value: "spanish-a2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await vi.waitFor(() => expect(stored).toBe("spanish-a2"));
  });

  test.each([403, 404])(
    "says a course is gone or no longer managed when its label is refused with %i",
    async (status) => {
      let refused = false;
      renderAt("/example/courses/course-1", {
        braivo: {
          readCourse: async (input: { courseId: string }) => {
            if (refused) throw new BraivoError(status, "refused");
            return readCourse(input);
          },
          setCourseUrlLabel: async () => {
            refused = true;
            throw new BraivoError(status, "refused");
          },
        },
      });
      const field = await screen.findByRole("textbox", { name: "Label in its link" });

      fireEvent.change(field, { target: { value: "spanish-a1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save label" }));

      expect(
        await screen.findByText("This course does not exist, or you do not manage it."),
      ).toBeTruthy();
    },
  );

  test.each([400, 403])(
    "says a label refused with %i needs a reload, reading the course again",
    async (status) => {
      const reading = vi.fn(readCourse);
      renderAt("/example/courses/course-1", {
        braivo: {
          readCourse: reading,
          setCourseUrlLabel: async () => {
            throw new BraivoError(status, "refused");
          },
        },
      });
      const field = await screen.findByRole("textbox", { name: "Label in its link" });

      fireEvent.change(field, { target: { value: "spanish-a1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save label" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "The label was not saved. Reload the page, then try again.",
      );
      await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    },
  );

  test("refuses a label with no letter or digit before sending it", async () => {
    const setCourseUrlLabel = vi.fn();
    renderAt("/example/courses/course-1", { braivo: { readCourse, setCourseUrlLabel } });
    const field = (await screen.findByRole("textbox", {
      name: "Label in its link",
    })) as HTMLInputElement;

    fireEvent.change(field, { target: { value: "?!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));

    expect(field.validationMessage).toBe("Enter a letter or a digit.");
    expect(setCourseUrlLabel).not.toHaveBeenCalled();
  });

  test("stops naming a course in its tab once a reload finds it gone", async () => {
    let gone = false;
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async (input: { courseId: string }) => {
          if (gone) throw new BraivoError(404, "Braivo answered 404.");
          return readCourse(input);
        },
      },
    });
    await vi.waitFor(() => expect(document.title).toBe("Beginners · Example School"));

    gone = true;
    await router.invalidate();

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Braivo Console"));
  });

  test("tells an owner an organization has no courses yet, under the page's heading", async () => {
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
  });

  test("reads a course its organization does not have as not found", async () => {
    renderAt("/example/courses/elsewhere", { braivo: { readCourse } });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
  });

  test("asks nothing scoped to a course before that course is the organization's", async () => {
    const learnerProgress = vi.fn();
    const listMembers = vi.fn(async () => members);
    renderAt("/example/courses/elsewhere/learners/u2", {
      braivo: {
        listCourses: async () => [
          { id: "course-1", number: 4732, title: "Beginners", urlLabel: "beginners" },
        ],
        learnerProgress,
        listMembers,
      },
    });

    expect(
      await screen.findByText(
        "This learner does not exist, or their progress is not yours to see.",
      ),
    ).toBeTruthy();
    // An owner of both organizations could read this report; what they may not
    // do is pair it with another organization's roster.
    expect({
      learnerProgress: learnerProgress.mock.calls,
      listMembers: listMembers.mock.calls,
    }).toEqual({ learnerProgress: [], listMembers: [] });
  });

  test("leads from a course to its learners' progress, which it no longer reads itself", async () => {
    const progress = vi.fn(courseProgress);
    renderAt("/example/courses/course-1", { braivo: { readCourse, courseProgress: progress } });

    expect(
      (await screen.findByRole("link", { name: "Learner progress" })).getAttribute("href"),
    ).toBe("/example/courses/course-1/progress");
    expect(progress.mock.calls).toEqual([]);
  });

  test("shows what a course teaches: each objective's passages, and its tasks' answers", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const greetings = await screen.findByRole("article", { name: "1. Greetings" });
    expect(within(greetings).getAllByText("Hola.")).toHaveLength(2);
    expect(within(greetings).getAllByText("Unidad 1")).toHaveLength(2);
    expect(within(greetings).getByText("Hello, in Spanish?")).toBeTruthy();
    expect(within(greetings).getByText("Correct answer").closest("li")?.textContent).toBe(
      "Hola Correct answer",
    );
    expect(within(greetings).getByText("Adiós is goodbye.")).toBeTruthy();

    const numbers = screen.getByRole("article", { name: "2. Numbers" });
    expect(within(numbers).getByText("No tasks: learners are not asked about it.")).toBeTruthy();
  });

  test("shows a typed task's accepted answers, and corrects them keeping its language", async () => {
    const typed = {
      id: "t2",
      kind: "typed" as const,
      prompt: "Goodbye, in Spanish?",
      accepted: ["adiós", "adios"],
      answerLanguage: "es",
      citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
      published: true,
    };
    const defineTasks = vi.fn(async () => [{ id: "t3", added: true, published: true }]);
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: async () => ({
          ...beginners,
          objectives: [{ ...beginners.objectives[0]!, tasks: [typed] }, beginners.objectives[1]!],
        }),
        defineTasks,
      },
    });

    const greetings = await screen.findByRole("article", { name: "1. Greetings" });
    expect(within(greetings).getByText("Shown after a miss").closest("li")?.textContent).toBe(
      "adiós Shown after a miss",
    );
    expect(within(greetings).getByText("adios")).toBeTruthy();
    expect(
      within(greetings).getByRole("button", { name: "Retire “Goodbye, in Spanish?”" }),
    ).toBeTruthy();

    fireEvent.click(within(greetings).getByRole("button", { name: "Edit “Goodbye, in Spanish?”" }));
    fireEvent.change(screen.getByLabelText("Accepted answers, one a line"), {
      target: { value: "adiós\n\nadios\nchao" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(defineTasks).toHaveBeenCalledWith(
        {
          organizationId: "org-1",
          tasks: [
            {
              objectiveId: "greetings",
              kind: "typed",
              prompt: "Goodbye, in Spanish?",
              accepted: ["adiós", "adios", "chao"],
              answerLanguage: "es",
              citations: [{ sourceId: "s1", quote: "Hola." }],
              replaces: "t2",
            },
          ],
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("retires a task only once the owner confirms, then reads the course again", async () => {
    // Braivo reads the course without a task once it is retired.
    let retired = false;
    const retireTasks = vi.fn(async () => {
      retired = true;
    });
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      if (!retired) return course;
      const [greetings, ...rest] = course.objectives;
      return { ...course, objectives: [{ ...greetings!, tasks: [] }, ...rest] };
    });
    renderAt("/example/courses/course-1", {
      braivo: { readCourse: reading, retireTasks },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retire “Hello, in Spanish?”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(retireTasks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    const confirming = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirming).getByRole("button", { name: "Retire" }));

    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    expect(retireTasks).toHaveBeenCalledWith(
      { organizationId: "org-1", taskIds: ["t1"] },
      { signal: expect.any(AbortSignal) },
    );
    // The task is gone with its button, so a keyboard user resumes at its objective.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" })),
    );
  });

  test("moves the focus from a retired task only once the course is read without it", async () => {
    let retired = false;
    const reloaded = Promise.withResolvers<void>();
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      if (!retired) return course;
      await reloaded.promise;
      const [greetings, ...rest] = course.objectives;
      return { ...course, objectives: [{ ...greetings!, tasks: [] }, ...rest] };
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: reading,
        retireTasks: async () => {
          retired = true;
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    const heading = screen.getByRole("heading", { name: "1. Greetings" });
    expect(document.activeElement).not.toBe(heading);

    reloaded.resolve();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("button", { name: "Retire “Hello, in Spanish?”" })).toBeNull();
  });

  test("says so when a task could not be retired", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        retireTasks: async () => {
          throw new BraivoError(503, "Braivo answered 503.");
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    expect(await screen.findByText("The task could not be retired. Try again.")).toBeTruthy();
    // Still there to try again, and focused to.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Retire “Hello, in Spanish?”" }),
    );
  });

  test("says a task is retiring, focused, until Braivo fails to answer in time, a new alert each time", async () => {
    const retireTasks = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) =>
      stall(options),
    );
    renderAt("/example/courses/course-1", { braivo: { readCourse, retireTasks } });

    async function confirm() {
      fireEvent.click(screen.getByRole("button", { name: "Retire “Hello, in Spanish?”" }));
      const dialog = await screen.findByRole("alertdialog");
      vi.useFakeTimers();
      fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
      // The dialog hands focus back on a timer.
      await waitOut(0);
    }

    await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" });
    await confirm();
    // Still named for its task, one of several that may be retiring.
    const retiring = screen.getByRole("button", { name: "Retiring “Hello, in Spanish?”" });
    expect(retiring.textContent).toBe("Retiring…");
    expect(retiring.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retiring);
    // Asked once: clicked again meanwhile, it opens nothing.
    fireEvent.click(retiring);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Not edited meanwhile: the retirement could land under the edit, or fail unsaid.
    const edit = screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);

    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();
    const failed = screen.getByRole("alert");
    expect(failed.textContent).toBe("The task could not be retired. Try again.");
    // Not beside the buttons, where at 320px it squeezes the question.
    expect(failed.closest("[data-slot=card-action]")).toBeNull();
    const retire = screen.getByRole("button", { name: "Retire “Hello, in Spanish?”" });
    expect(document.activeElement).toBe(retire);
    expect((edit as HTMLButtonElement).disabled).toBe(false);

    await confirm();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();
    expect(screen.getByRole("alert")).not.toBe(failed);
    expect(retireTasks).toHaveBeenCalledTimes(2);
  });

  test("leaves the focus in another task's editor when a retirement lands meanwhile", async () => {
    const retired = Promise.withResolvers<void>();
    let gone = false;
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      const other = { ...task!, id: "t3", prompt: "Goodbye, in Spanish?" };
      const tasks = gone ? [other] : [task!, other];
      return { ...course, objectives: [{ ...greetings!, tasks }, ...rest] };
    });
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: reading,
        retireTasks: async () => {
          await retired.promise;
          gone = true;
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit “Goodbye, in Spanish?”" }));
    const question = screen.getByLabelText("Question");
    question.focus();

    retired.resolve();
    await vi.waitFor(() => expect(screen.queryByText("Hello, in Spanish?")).toBeNull());
    expect(document.activeElement).toBe(question);
  });

  test("says nothing failed when a retry finds its owner signed out", async () => {
    const retireTasks = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockRejectedValueOnce(new BraivoError(401, "Signed out."));
    const { auth } = renderAt("/example/courses/course-1", { braivo: { readCourse, retireTasks } });
    async function confirm() {
      fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
      fireEvent.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
      );
    }

    await confirm();
    await screen.findByRole("alert");
    await auth.signOut();
    await confirm();

    // Until sign-in shows, the earlier failure is not said again.
    await vi.waitFor(() => expect(retireTasks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("The task could not be retired. Try again.")).toBeNull();
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
  });

  test("sends someone signed out before retiring a task to sign in, and back", async () => {
    const { auth, router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        retireTasks: vi.fn().mockRejectedValue(new BraivoError(401, "Signed out.")),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retire “Hello, in Spanish?”" }));
    const dialog = await screen.findByRole("alertdialog");
    await auth.signOut();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/example/courses/course-1" });
  });

  test("sends someone signed out before correcting a task to sign in, and back", async () => {
    const { auth, router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        defineTasks: vi.fn().mockRejectedValue(new BraivoError(401, "Signed out.")),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    await auth.signOut();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/example/courses/course-1" });
  });

  test("keeps a correction Braivo does not answer in time, to save again or cancel", async () => {
    const defineTasks = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) =>
      stall(options),
    );
    renderAt("/example/courses/course-1", { braivo: { readCourse, defineTasks } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hi, in Spanish?" } });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    const failed = screen.getByText("The task could not be corrected. Try again.");
    expect(document.activeElement).toBe(failed.closest("[role=alert]"));
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
      "Hi, in Spanish?",
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("fails the page in its place when a correction's reload cannot read the organization in time", async () => {
    let corrected = false;
    const listOrganizations = vi.fn(async (options?: { signal?: AbortSignal }) =>
      corrected ? stall(options) : [school],
    );
    renderAt("/example/courses/course-1", {
      braivo: {
        listOrganizations,
        readCourse,
        defineTasks: async () => {
          corrected = true;
          return [{ id: "t2", added: true, published: true }];
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
  });

  test("corrects a task with its passages, then reads the course again", async () => {
    let corrected = false;
    let answer!: () => void;
    const defineTasks = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = () => {
            corrected = true;
            resolve(["t2"]);
          };
        }),
    );
    // Options kept in their order, which the correction must keep too.
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      const shown = corrected ? { ...task!, id: "t2", answer: 1 } : task!;
      return {
        ...course,
        objectives: [{ ...greetings!, tasks: [{ ...shown, keepOrder: true as const }] }, ...rest],
      };
    });
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, defineTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(defineTasks).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        tasks: [
          {
            objectiveId: "greetings",
            kind: "choice",
            prompt: "Hello, in Spanish?",
            options: ["Hola", "Adiós"],
            answer: 1,
            explanation: "Adiós is goodbye.",
            keepOrder: true,
            citations: [{ sourceId: "s1", quote: "Hola." }],
            replaces: "t1",
          },
        ],
      },
      { signal: expect.any(AbortSignal) },
    );
    // While it is sent, the edit can be neither changed nor cancelled.
    expect(screen.getByRole("button", { name: "Cancel" }).closest("fieldset")?.disabled).toBe(true);

    answer();
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Correct answer").closest("li")?.textContent).toBe(
      "Adiós Correct answer",
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" })),
    );
  });

  test("keeps a correction's editor locked until the corrected course is read", async () => {
    let corrected = false;
    const reloaded = Promise.withResolvers<void>();
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      if (!corrected) return course;
      await reloaded.promise;
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      return {
        ...course,
        objectives: [{ ...greetings!, tasks: [{ ...task!, id: "t2", answer: 1 }] }, ...rest],
      };
    });
    const defineTasks = vi.fn(async () => {
      corrected = true;
      return ["t2"];
    });
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, defineTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));

    // Stored, but the course not read again yet: the old task is never offered to edit.
    expect(screen.getByRole("button", { name: "Cancel" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit “Hello, in Spanish?”" })).toBeNull();

    reloaded.resolve();
    await vi.waitFor(() =>
      expect(screen.getByText("Correct answer").closest("li")?.textContent).toBe(
        "Adiós Correct answer",
      ),
    );
  });

  test("offers to try again when the corrected course cannot be read in time", async () => {
    let corrected = false;
    let stalled = true;
    const reading = vi.fn(
      async (input: { courseId: string }, options?: { signal?: AbortSignal }) => {
        if (corrected && stalled) return stall(options);
        const course = await readCourse(input);
        if (!corrected) return course;
        const [greetings, ...rest] = course.objectives;
        const [task] = greetings!.tasks;
        return {
          ...course,
          objectives: [{ ...greetings!, tasks: [{ ...task!, id: "t2", answer: 1 }] }, ...rest],
        };
      },
    );
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: reading,
        defineTasks: async () => {
          corrected = true;
          return [{ id: "t2", added: true, published: true }];
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitOut(REQUEST_DEADLINE_MS);
    vi.useRealTimers();

    // Stored, so never said to have failed: the page offers to read it again.
    expect(screen.queryByText("The task could not be corrected. Try again.")).toBeNull();
    stalled = false;
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await vi.waitFor(() =>
      expect(screen.getByText("Correct answer").closest("li")?.textContent).toBe(
        "Adiós Correct answer",
      ),
    );
  });

  test("leaves a task as it was when its edit is cancelled, or fails", async () => {
    const defineTasks = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
      .mockRejectedValueOnce(
        new BraivoError(409, "Braivo answered 409.", "Task 0 is the same…", "DUPLICATE_CORRECTION"),
      )
      .mockRejectedValueOnce(new BraivoError(409, "Braivo answered 409.", "Task 0 replaces…"));
    renderAt("/example/courses/course-1", { braivo: { readCourse, defineTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hi, in Spanish?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const failed = await screen.findByText("The task could not be corrected. Try again.");
    // Still open with the edit, to save again, and the reason focused.
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
      "Hi, in Spanish?",
    );
    expect(document.activeElement).toBe(failed.closest("[role=alert]"));

    // The same as another task: the edit's to change, not the page's to reload.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Another task of this objective is already the same. Review its tasks before editing or publishing.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload the page" })).toBeNull();
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
      "Hi, in Spanish?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Someone changed or retired this task since the page loaded."),
    ).toBeTruthy();
    expect(defineTasks).toHaveBeenCalledTimes(3);
    // Saving again cannot help: reloading shows the course as stored.
    fireEvent.click(screen.getByRole("button", { name: "Reload the page" }));
    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" }));
  });

  test("reloads a course once, keeping the edit until it is read, however often asked", async () => {
    const reloaded = Promise.withResolvers<void>();
    let calls = 0;
    const reading = vi.fn(async (input: { courseId: string }) => {
      calls += 1;
      if (calls > 1) await reloaded.promise;
      return readCourse(input);
    });
    const { router } = renderAt("/example/courses/course-1", {
      braivo: {
        readCourse: reading,
        defineTasks: async () => {
          throw new BraivoError(409, "Braivo answered 409.", "Task 0 replaces…");
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const reload = await screen.findByRole("button", { name: "Reload the page" });
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(reload);
    fireEvent.click(reload);
    expect(reload.getAttribute("aria-disabled")).toBe("true");
    expect(invalidate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    // Open until the course is read again, not closed onto the one read before.
    expect(screen.getByLabelText("Question")).toBeTruthy();

    reloaded.resolve();
    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    expect(reading).toHaveBeenCalledTimes(2);
  });

  test("closes an edit whose task a reload no longer lists", async () => {
    let reloaded = false;
    const reading = vi.fn(async (input: { courseId: string }) => {
      const course = await readCourse(input);
      const [greetings, ...rest] = course.objectives;
      const [task] = greetings!.tasks;
      const other = { ...task!, id: "t3", prompt: "Goodbye, in Spanish?" };
      // Someone else corrected "Hello, in Spanish?" meanwhile, into t4.
      const tasks = reloaded ? [{ ...task!, id: "t4" }] : [task!, other];
      return { ...course, objectives: [{ ...greetings!, tasks }, ...rest] };
    });
    const retireTasks = vi.fn(async () => {
      reloaded = true;
    });
    renderAt("/example/courses/course-1", { braivo: { readCourse: reading, retireTasks } });

    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello, in Spanish?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Retire “Goodbye, in Spanish?”" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    const edit = screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" });
    expect((edit as HTMLButtonElement).disabled).toBe(false);
  });
});
