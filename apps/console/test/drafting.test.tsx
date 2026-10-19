// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { BraivoError } from "@braivo/server/client";
import { createBrowserHistory } from "@tanstack/react-router";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { school, saludos, hello, drafted, authoring } from "./fixtures.ts";
import {
  stall,
  waitOut,
  renderAt,
  expectProxyTimeoutExplained,
  expectAiAppGuide,
  expectLockedInFocus,
  answerLeaving,
} from "./render.tsx";

describe("the console", () => {
  const LEAVE_REVIEW =
    "Leave this page? The draft and your changes to it will be lost, and drafting again uses another of this month's AI requests.";

  const LEAVE_UNFINISHED =
    "Leave this page? Some or all of this course may already be saved: leaving does not undo it, and may leave it unfinished.";

  test("drafts a course from a source, keeps what the owner keeps, and creates it", async () => {
    const braivo = authoring();
    const { router } = renderAt("/example/sources/s1", { braivo });

    expect(await screen.findByText("Hola significa hello.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Learners"), { target: { value: "grade 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft a course" }));

    // Reviewed before anything is stored, with what Braivo left out said.
    expect(await screen.findByText(drafted.refused[0]!)).toBeTruthy();
    expect(braivo.draftCourse).toHaveBeenCalledWith(
      { organizationId: "org-1", sourceId: "s1", audience: "grade 2" },
      { signal: expect.any(AbortSignal) },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep “Hi?”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    // Live once created: the page it lands on says so, and where.
    const site = await screen.findByRole("link", { name: "example.braivo.app/c/4732-beginners" });
    expect(site.getAttribute("href")).toBe("https://example.braivo.app/c/4732-beginners");
    expect(site.parentElement?.textContent).toBe(
      "Open to every learner in Example School at example.braivo.app/c/4732-beginners.",
    );
    // What was kept, and only that.
    expect(braivo.acceptDraft).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        sourceId: "s1",
        title: "Saludos",
        objectives: [{ ...drafted.objectives[0], tasks: [drafted.objectives[0]!.tasks[0]] }],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("holds drafting still while it runs, says so, and keeps the focus on its button", async () => {
    const drafting = Promise.withResolvers<typeof drafted>();
    const braivo = { ...authoring(), draftCourse: vi.fn(() => drafting.promise) };
    renderAt("/example/sources/s1", { braivo });
    const button = await screen.findByRole("button", { name: "Draft a course" });
    const form = button.closest("form")!;
    // Present from the start, so what it says next is announced.
    const status = within(form).getByRole("status");
    expect(status.textContent).toBe("You review the draft before learners see any of it.");
    expect(within(form).getByText(/reads the whole source.*a few minutes/)).toBeTruthy();
    button.focus();

    fireEvent.click(button);

    await vi.waitFor(() => expect(braivo.draftCourse).toHaveBeenCalled());
    expect(status.textContent).toMatch(/drafting the course.*a few minutes/);
    // Named as before, as a focused button's new name may go unannounced.
    expect(within(form).getByRole("button", { name: "Draft a course" })).toBe(button);
    expectLockedInFocus(button);
    // Enter in a field submits however the button is marked.
    fireEvent.submit(form);
    expect((screen.getByLabelText("Learners") as HTMLInputElement).readOnly).toBe(true);
    expect(braivo.draftCourse).toHaveBeenCalledTimes(1);
    drafting.resolve(drafted);
    // The button is gone: the review shown in its place takes the focus, and
    // gives it back when discarded.
    const review = await screen.findByRole("heading", { name: "Review the draft" });
    expect(document.activeElement).toBe(review);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Draft a course" }));
  });

  test("leaves the focus alone once it left the form while drafting", async () => {
    const drafting = Promise.withResolvers<typeof drafted>();
    const braivo = { ...authoring(), draftCourse: vi.fn(() => drafting.promise) };
    renderAt("/example/sources/s1", { braivo });
    const button = await screen.findByRole("button", { name: "Draft a course" });
    button.focus();
    fireEvent.click(button);
    // As clicking the source's text does: the focus goes to the page.
    button.blur();

    drafting.resolve(drafted);

    expect(await screen.findByRole("heading", { name: "Review the draft" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  test("holds a review still while the course is created, the focus kept on its button", async () => {
    const creating = Promise.withResolvers<string>();
    const braivo = authoring();
    braivo.acceptDraft.mockImplementation(() => creating.promise);
    const { router } = renderAt("/example/sources/s1", { braivo });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    const button = await screen.findByRole("button", { name: "Create course" });
    // Enter in the title, which the review then locks.
    screen.getByLabelText("Course title").focus();

    fireEvent.submit(button.closest("form")!);

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    expectLockedInFocus(button);
    // Enter in a field submits however the button is marked.
    fireEvent.submit(button.closest("form")!);
    const discard = screen.getByRole("button", { name: "Discard draft" });
    fireEvent.click(discard);
    expect(discard.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Create course" })).toBe(button);
    expect(braivo.acceptDraft).toHaveBeenCalledTimes(1);
    creating.resolve("course-1");
    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
  });

  test("keeps a draft under review when Braivo's AI is turned off meanwhile", async () => {
    const organizations = [{ ...school, aiEnabled: true }];
    const { router } = renderAt("/example/sources/s1", { organizations, braivo: authoring() });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keep “Hello?”" }));

    organizations[0] = { ...school, aiEnabled: false };
    await router.invalidate();

    expect(screen.getByRole("button", { name: "Create course" })).toBeTruthy();
    // The owner's choices too: unticked stays unticked.
    expect(
      screen.getByRole("checkbox", { name: "Keep “Hello?”" }).getAttribute("aria-checked"),
    ).toBe("false");

    // Discarded, there is no button to return to: the focus goes to why.
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Draft a course" }));
    expect(screen.queryByRole("button", { name: "Draft a course" })).toBeNull();
  });

  test("keeps a draft under way when Braivo's AI is turned off meanwhile", async () => {
    const drafting = Promise.withResolvers<typeof drafted>();
    const organizations = [{ ...school, aiEnabled: true }];
    const { router } = renderAt("/example/sources/s1", {
      organizations,
      braivo: { ...authoring(), draftCourse: vi.fn(() => drafting.promise) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));

    organizations[0] = { ...school, aiEnabled: false };
    await router.invalidate();
    // Still said to be under way: it was asked for, and may still count.
    expect(screen.getByRole("status").textContent).toMatch(/drafting the course/);

    drafting.resolve(drafted);
    expect(await screen.findByRole("heading", { name: "Review the draft" })).toBeTruthy();
  });

  test("says why a draft under way failed once Braivo's AI was turned off, focusing why", async () => {
    const drafting = Promise.withResolvers<typeof drafted>();
    const organizations = [{ ...school, aiEnabled: true }];
    const { router } = renderAt("/example/sources/s1", {
      organizations,
      braivo: { ...authoring(), draftCourse: vi.fn(() => drafting.promise) },
    });
    const button = await screen.findByRole("button", { name: "Draft a course" });
    button.focus();
    fireEvent.click(button);
    organizations[0] = { ...school, aiEnabled: false };
    await router.invalidate();

    drafting.reject(new BraivoError(524, "Braivo answered 524."));

    expectProxyTimeoutExplained(await screen.findByText(/timed out/));
    expect(screen.queryByRole("button", { name: "Draft a course" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Draft a course" }));
  });

  test("offers no draft where Braivo's AI is off, saying what to do instead", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { organizations: [{ ...school, aiEnabled: false }], braivo });

    const heading = await screen.findByRole("heading", { name: "Draft a course" });
    expect(screen.queryByRole("button", { name: "Draft a course" })).toBeNull();
    expect(screen.queryByLabelText("Learners")).toBeNull();
    const said = heading.nextElementSibling!.textContent;
    expect(said).toMatch(/off for this organization/);
    expect(said).toMatch(/Ask whoever runs Braivo/);
    expectAiAppGuide(heading.nextElementSibling as HTMLElement);
    expect(braivo.draftCourse).not.toHaveBeenCalled();
  });

  test.each([
    [
      "has no model",
      new BraivoError(
        501,
        "Braivo answered 501.",
        "This Braivo installation has no AI of its own: its operator has not set ANTHROPIC_API_KEY. Use your own AI app, such as Claude or ChatGPT, connected to Braivo.",
        "AI_UNAVAILABLE",
      ),
    ],
    [
      "does not let the organization use it",
      new BraivoError(
        403,
        "Braivo answered 403.",
        "This organization may not use this installation's AI; ask its operator, or use your own AI app, such as Claude or ChatGPT, connected to Braivo.",
        "AI_NOT_ENTITLED",
      ),
    ],
  ])(
    "says Braivo's AI is off when the installation %s, though the listing said it was on",
    async (_case, refusal) => {
      renderAt("/example/sources/s1", {
        organizations: [{ ...school, aiEnabled: true }],
        braivo: { ...authoring(), draftCourse: vi.fn().mockRejectedValue(refusal) },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));

      const alert = await screen.findByText(/off for this organization/);
      expect(alert.textContent).toMatch(/Ask whoever runs Braivo for you to turn it on/);
      expect(alert.textContent).not.toMatch(/ANTHROPIC_API_KEY|operator/);
    },
  );

  test("says a proxy cut off drafting, rather than to try again", async () => {
    renderAt("/example/sources/s1", {
      braivo: {
        ...authoring(),
        // Cloudflare's timeout; nginx's is 504.
        draftCourse: vi.fn().mockRejectedValue(new BraivoError(524, "Braivo answered 524.")),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));

    expectProxyTimeoutExplained(await screen.findByText(/timed out/));
  });

  test("creates a course with the owner's corrections to a proposed task", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit “Hello?”" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Question"));
    // An open edit is not yet part of the course.
    expect(
      (screen.getByRole("button", { name: "Create course" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hi, in Spanish?" } });
    fireEvent.click(screen.getByRole("radio", { name: "B is correct" }));
    fireEvent.change(screen.getByLabelText("Why the answer is right"), {
      target: { value: "Adiós is goodbye." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Hi, in Spanish?")).toBeTruthy();
    // Back where the edit was opened from, now named by the corrected question.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit “Hi, in Spanish?”" }),
      ),
    );
    // An edit left open on an objective then dropped closes with it.
    fireEvent.click(screen.getByRole("button", { name: "Edit “Hi?”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 1" }));
    expect(screen.queryByLabelText("Question")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    const [{ objectives }] = braivo.acceptDraft.mock.calls[0] as unknown as [
      { objectives: { tasks: object[] }[] },
    ];
    expect(objectives[0]!.tasks[0]).toEqual({
      kind: "choice",
      prompt: "Hi, in Spanish?",
      options: ["Hola", "Adiós"],
      answer: 1,
      explanation: "Adiós is goodbye.",
      citations: [hello],
    });
  });

  test("creates a course with the owner's correction to an objective's title", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    const title = await screen.findByRole("textbox", { name: "Objective 1" });
    expect((title as HTMLInputElement).required).toBe(true);
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    // Checked like the course's title, before anything is locked in, said
    // under it, and the focus taken there from the button at the bottom.
    const objective = screen.getByRole("article", { name: "Objective 1" });
    const said = await within(objective).findByRole("alert");
    expect(said.textContent).toBe("Give objective 1 a title.");
    expect(document.activeElement).toBe(title);
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.getAttribute("aria-describedby")).toBe(said.id);
    expect(braivo.acceptDraft).not.toHaveBeenCalled();

    // The first to fix in page order, even with the course title also blank;
    // said again, so announced again.
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "" } });
    screen.getByRole("button", { name: "Create course" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    expect(within(objective).getByRole("alert")).not.toBe(said);
    expect(screen.getByLabelText("Course title").getAttribute("aria-invalid")).toBeNull();
    // Another field changed fixes nothing: the mark stays until this one changes.
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Saludos" } });
    expect(title.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(title, { target: { value: " Greet someone " } });
    expect(within(objective).queryByRole("alert")).toBeNull();
    expect(title.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByRole("article", { name: "Objective 1: Greet someone" })).toBeTruthy();
    // A dropped objective's title is not sent, so it is not checked either.
    fireEvent.change(screen.getByRole("textbox", { name: "Objective 2" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    expect(braivo.acceptDraft).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        sourceId: "s1",
        title: "Saludos",
        objectives: [{ ...drafted.objectives[0], title: "Greet someone" }],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("refuses an objective kept without a task, which learners would wait on", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keep “Bye?”" }));
    // An objective's title comes first, as it does on the page.
    const title = screen.getByRole("textbox", { name: "Objective 2" });
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    expect(await screen.findByText("Give objective 2 a title.")).toBeTruthy();
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: "Say goodbye" } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(
      await screen.findByText(
        "Keep a task of objective 2, or untick the objective: learners would wait on it with nothing to practise.",
      ),
    ).toBeTruthy();
    const keep = screen.getByRole("checkbox", { name: "Keep objective 2" });
    expect(document.activeElement).toBe(keep);
    expect(keep.getAttribute("aria-invalid")).toBe("true");
    const objective = screen.getByRole("article", { name: "Objective 2: Say goodbye" });
    expect(keep.getAttribute("aria-describedby")).toBe(within(objective).getByRole("alert").id);
    expect(braivo.acceptDraft).not.toHaveBeenCalled();

    // Fixed by a task kept, not by another field changed.
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Saludos 2" } });
    expect(keep.getAttribute("aria-invalid")).toBe("true");
    const bye = screen.getByRole("checkbox", { name: "Keep “Bye?”" });
    fireEvent.click(bye);
    expect(keep.getAttribute("aria-invalid")).toBeNull();
    expect(within(objective).queryByRole("alert")).toBeNull();

    // Or by the objective unticked.
    fireEvent.click(bye);
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(keep.getAttribute("aria-invalid")).toBe("true"));
    fireEvent.click(keep);
    expect(keep.getAttribute("aria-invalid")).toBeNull();
    expect(within(objective).queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() =>
      expect(braivo.acceptDraft).toHaveBeenCalledWith(
        expect.objectContaining({ objectives: [drafted.objectives[0]] }),
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("says why a course could not be drafted, or created", async () => {
    const braivo = {
      ...authoring(),
      draftCourse: vi.fn(async (): Promise<typeof drafted> => {
        throw new BraivoError(400, "Braivo answered 400.", "The source is too long to draft from.");
      }),
    };
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    expect(await screen.findByText("The source is too long to draft from.")).toBeTruthy();

    braivo.draftCourse.mockImplementation(async () => drafted);
    braivo.acceptDraft.mockImplementation(async () => {
      throw new BraivoError(409, "Braivo answered 409.", "Key d1 names another objective.");
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    expect(await screen.findByText("Key d1 names another objective.")).toBeTruthy();
  });

  test("stops a draft nobody is waiting for once the owner leaves the page", async () => {
    let signal: AbortSignal | undefined;
    const draftCourse = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>(() => {});
    });
    const { router } = renderAt("/example/sources/s1", {
      braivo: { ...authoring(), draftCourse },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  test("asks before leaving a draft under review, and stays if the owner says so", async () => {
    const confirm = answerLeaving(false);
    const { router } = renderAt("/example/sources/s1", {
      braivo: { ...authoring(), listCourses: async () => [] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    const create = await screen.findByRole("button", { name: "Create course" });

    // Blocked, the navigation never settles.
    void router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_REVIEW));
    expect(router.history.location.pathname).toBe("/example/sources/s1");
    expect(screen.getByRole("button", { name: "Create course" })).toBe(create);

    // Discarded, nothing is left to lose.
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    expect(router.history.location.pathname).toBe("/example");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("asks before going back from a draft under review", async () => {
    const confirm = answerLeaving(false);
    // The browser's Back, which a memory history never blocks.
    window.history.replaceState(null, "", "/example");
    const history = createBrowserHistory();
    onTestFinished(() => {
      history.destroy();
      window.history.replaceState(null, "", "/");
    });
    const { router } = renderAt("/example", {
      braivo: { ...authoring(), listCourses: async () => [] },
      history,
    });
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s1" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    await screen.findByRole("button", { name: "Create course" });

    window.history.back();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_REVIEW));
    await vi.waitFor(() => expect(window.location.pathname).toBe("/example/sources/s1"));
    expect(screen.getByRole("button", { name: "Create course" })).toBeTruthy();

    confirm.mockReturnValue(true);
    window.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/example"));
  });

  test("says what may be stored after creating a course failed, and asks nothing once it is created", async () => {
    const confirm = answerLeaving(false);
    const braivo = authoring();
    braivo.acceptDraft.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { router } = renderAt("/example/sources/s1", { braivo });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    const retry = await screen.findByRole("button", { name: "Try again" });

    expect(
      screen.getByText(
        "Some or all of this course may already be saved: discarding the draft does not undo it.",
      ),
    ).toBeTruthy();
    void router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_UNFINISHED));
    expect(router.history.location.pathname).toBe("/example/sources/s1");

    fireEvent.click(retry);
    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("reviews no draft on another source's page than the one it was drafted from", async () => {
    answerLeaving(true);
    const { router } = renderAt("/example/sources/s1", { braivo: authoring() });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    expect(await screen.findByRole("button", { name: "Create course" })).toBeTruthy();
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s2" },
    });

    expect(await screen.findByRole("button", { name: "Draft a course" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create course" })).toBeNull();
  });

  test("lists a course created after the owner went to the course list", async () => {
    answerLeaving(true);
    const creating = Promise.withResolvers<string>();
    let created = false;
    const braivo = {
      ...authoring(),
      listCourses: async () =>
        created
          ? [
              {
                id: "course-1",
                number: 4732,
                title: "Beginners",
                urlLabel: "beginners",
                published: true,
              },
            ]
          : [],
    };
    braivo.acceptDraft.mockImplementation(async () => {
      const courseId = await creating.promise;
      created = true;
      return courseId;
    });
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await screen.findByText(/No courses/);
    creating.resolve("course-1");

    expect(await screen.findByRole("link", { name: "Beginners" })).toBeTruthy();
    expect(router.history.location.pathname).toBe("/example");
  });

  test("leaves a review usable when the course is created while the owner is leaving", async () => {
    answerLeaving(true);
    const creating = Promise.withResolvers<string>();
    const braivo = {
      ...authoring(),
      // The other source still loading when the course is created.
      getSource: ({ sourceId }: { sourceId: string }) =>
        sourceId === "s1" ? Promise.resolve(saludos) : new Promise(() => {}),
    };
    braivo.acceptDraft.mockImplementation(() => creating.promise);
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    void router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s2" },
    });
    // Left once the owner answers the question, which comes first.
    await vi.waitFor(() => expect(router.latestLocation.pathname).toBe("/example/sources/s2"));
    creating.resolve("course-1");
    await creating.promise;
    // Changing their mind before the other source loads.
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s1" },
    });

    expect(router.history.location.pathname).toBe("/example/sources/s1");
    // Sent again, it finishes as created, and opens the course.
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
  });

  test("leaves an owner on the page they returned to when the course they left is created", async () => {
    answerLeaving(true);
    const creating = Promise.withResolvers<string>();
    const braivo = { ...authoring(), listCourses: async () => [] };
    braivo.acceptDraft.mockImplementation(() => creating.promise);
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await router.navigate({
      to: "/$organizationSlug/sources/$sourceId",
      params: { organizationSlug: "example", sourceId: "s1" },
    });
    creating.resolve("course-1");
    await creating.promise;

    expect(router.history.location.pathname).toBe("/example/sources/s1");
  });

  test("refuses an overlong course title before sending anything", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "C".repeat(501) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(await screen.findByText("Keep the title of the course to 500 characters.")).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
  });

  test("refuses a title Braivo cannot store as text before sending anything", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Saludos\u0000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(
      await screen.findByText(
        "Remove the characters in the title of the course that are not text.",
      ),
    ).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
  });

  test("asks for a title before sending anything, since what is sent is locked in", async () => {
    const braivo = authoring();
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.change(await screen.findByLabelText("Course title"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(await screen.findByText("Give the course a title.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Course title"));
    expect(braivo.acceptDraft).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Course title").closest("fieldset")?.disabled).toBe(false);
  });

  test("finishes a course as reviewed when creating it failed halfway", async () => {
    const braivo = authoring();
    braivo.acceptDraft.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { router } = renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keep “Hi?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    // Tasks are stored by now: the review is locked, so a retry cannot differ.
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(
      screen.getByText(/^The review is locked: trying again sends the same choices/),
    ).toBeTruthy();
    const hi = screen.getByRole("checkbox", { name: "Keep “Hi?”" });
    expect(hi.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(retry);

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    // Sent again as first reviewed, "Hi?" still dropped, with a deadline of its own.
    const [first, second] = braivo.acceptDraft.mock.calls as unknown as [
      unknown,
      { signal: AbortSignal },
    ][];
    expect(second![0]).toEqual(first![0]);
    expect(JSON.stringify(first![0])).not.toContain("Hi?");
    expect(second![1].signal).not.toBe(first![1].signal);
  });

  test("gives up on creating a course Braivo does not answer, keeping the review to send again", async () => {
    const braivo = authoring();
    braivo.acceptDraft.mockImplementationOnce(
      (_input?: unknown, options?: { signal?: AbortSignal }) => stall(options),
    );
    const { router } = renderAt("/example/sources/s1", { braivo });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    const create = await screen.findByRole("button", { name: "Create course" });
    const status = within(create.closest("form")!).getByRole("status");
    expect(status.textContent).toBe("");
    // 10 seconds for each of four requests, plus the time what is sent takes at 100 KB/s.
    const sent = { title: "Saludos", objectives: drafted.objectives };
    const bytes = new Blob([JSON.stringify(sent)]).size;
    const deadline = 4 * REQUEST_DEADLINE_MS + bytes / 100;

    vi.useFakeTimers();
    fireEvent.click(create);
    expect(status.textContent).toBe("Creating the course…");
    await waitOut(deadline - 1);
    expect(status.textContent).toBe("Creating the course…");
    expect(screen.queryByText(/did not confirm/)).toBeNull();
    await waitOut(1);
    vi.useRealTimers();

    const said = await screen.findByText(
      "Braivo did not confirm the course was created. Check your connection, then try again to finish it as reviewed; retire what you would drop on the course page afterwards.",
    );
    expect(said.closest("[role=alert]")).toBeTruthy();
    expect(status.textContent).toMatch(/^Some or all of this course may already be saved/);
    expect(
      screen.getByRole("button", { name: "Discard draft" }).getAttribute("aria-disabled"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
  });

  test.each([504, 524])(
    "says a course cut off by a proxy's %s timeout may exist, not that it failed",
    async (status) => {
      const braivo = authoring();
      braivo.acceptDraft.mockRejectedValueOnce(
        new BraivoError(status, `Braivo answered ${status}.`),
      );
      renderAt("/example/sources/s1", { braivo });
      fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create course" }));

      expect(
        await screen.findByText(
          "Braivo did not confirm the course was created. Try again to finish it as reviewed; retire what you would drop on the course page afterwards.",
        ),
      ).toBeTruthy();
    },
  );

  test("keeps the review of an owner signed out meanwhile, offering to sign in elsewhere", async () => {
    const braivo = authoring();
    let signedIn = false;
    braivo.acceptDraft.mockImplementation(async () => {
      if (!signedIn) throw new BraivoError(401, "Signed out.");
      return "course-1";
    });
    const { router } = renderAt("/example/sources/s1", { braivo });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Keep “Hi?”" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    const alert = (await screen.findByText(/^You were signed out/)).closest<HTMLElement>(
      "[role=alert]",
    )!;
    expect(alert.textContent).toBe(
      "You were signed out. Sign in again in a new tab, then try again: your review stays here.",
    );
    const signIn = within(alert).getByRole("link", { name: "Sign in again in a new tab" });
    expect(signIn.getAttribute("href")).toBe("/login");
    expect(signIn.getAttribute("target")).toBe("_blank");
    expect(signIn.getAttribute("rel")).toBe("noopener");
    expect(router.history.location.pathname).toBe("/example/sources/s1");
    expect(screen.getByRole("checkbox", { name: "Keep “Hi?”" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    // Still signed out: said again, the review still kept.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(screen.getByText(/^You were signed out/).closest("[role=alert]")).not.toBe(alert),
    );

    // Signed in elsewhere: created.
    signedIn = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
  });

  test("sends someone signed out while drafting to sign in, and back", async () => {
    const { auth, router } = renderAt("/example/sources/s1", {
      braivo: {
        ...authoring(),
        draftCourse: vi.fn().mockRejectedValue(new BraivoError(401, "Signed out.")),
      },
    });
    const draft = await screen.findByRole("button", { name: "Draft a course" });
    await auth.signOut();

    fireEvent.click(draft);
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/example/sources/s1" });
  });
});
