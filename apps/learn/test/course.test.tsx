// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { type Activity, BraivoError, type BraivoClient, type Grade } from "@braivo/server/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { SPANISH_ID, typedActivity, activity, anotherActivity } from "./fixtures.ts";
import { renderAt } from "./render.tsx";

describe("the learn app", () => {
  test("asks the task, grades the answer, and moves on", async () => {
    const { nextActivity, submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
      submitAttempt: async () => ({
        kind: "choice",
        outcome: "failure",
        correctChoice: 0,
        explanation: "Preterite.",
      }),
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    // What is being practised, not only why.
    expect(screen.getByText("New · Past tense")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledWith("c1", { signal: expect.any(AbortSignal) });

    fireEvent.click(screen.getByRole("button", { name: "hablo" }));

    expect(await screen.findByText("Not quite")).toBeTruthy();
    // Named in the alert too, so a learner need not go back to the option
    // marked correct once Continue takes the focus.
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The answer: hablé")).toBeTruthy();
    expect(within(alert).getByText("Preterite.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Correct/ })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledWith(
      { courseId: "c1", id: expect.any(String), taskId: "t1", response: { choice: 1 } },
      { signal: expect.any(AbortSignal) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // The next activity is loaded, starts unanswered, and has the focus
    // Continue had, so a keyboard or screen-reader learner lands on it.
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText("Not quite")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Past tense of 'comer'?" }),
    );
    expect(screen.getByText("Try again · Past tense")).toBeTruthy();
    expect(screen.getByText("Let's practise this again.")).toBeTruthy();
  });

  test("asks a typed task in a field, sends the text exactly as typed, and says Correct once", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      // Correct on another accepted spelling than the one Braivo names.
      submitAttempt: async () => ({ kind: "typed", outcome: "success", correctAnswer: "bin" }),
    });

    const field = await screen.findByRole("textbox", { name: "I am tired: Ich ___ müde." });
    // Focused, so the learner types straight away; nothing fixes their word.
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(field, { target: { value: " Bin " } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Correct");
    // Said once, by the alert: the one field needs no mark of its own.
    expect(screen.getAllByText("Correct")).toHaveLength(1);
    expect(submitAttempt).toHaveBeenCalledWith(
      { courseId: "c1", id: expect.any(String), taskId: "t2", response: { text: " Bin " } },
      { signal: expect.any(AbortSignal) },
    );
    // What was sent stays on screen, locked; no correction on a success.
    expect((field as HTMLInputElement).value).toBe(" Bin ");
    expect(field.hasAttribute("readonly")).toBe(true);
    expect(screen.queryByText(/The answer:/)).toBeNull();
  });

  test("sends nothing while the field is blank: a stray Enter is no answer", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
    });

    const field = await screen.findByRole("textbox", { name: "I am tired: Ich ___ müde." });
    const check = screen.getByRole("button", { name: "Check" });
    for (const value of ["", " \u00a0 "]) {
      fireEvent.change(field, { target: { value } });
      expect((check as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(check);
      fireEvent.submit(field.closest("form")!);
    }
    fireEvent.change(field, { target: { value: "b" } });
    expect((check as HTMLButtonElement).disabled).toBe(false);
    expect(submitAttempt).not.toHaveBeenCalled();
    expect(field.hasAttribute("readonly")).toBe(false);
  });

  test("names the answer when a typed one misses, and resends the same text when unconfirmed", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ kind: "typed", outcome: "failure", correctAnswer: "bin" });
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      submitAttempt,
    });

    const field = await screen.findByRole("textbox", { name: "I am tired: Ich ___ müde." });
    fireEvent.change(field, { target: { value: "ben" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    // Locked on the text sent: another would conflict with it if it was recorded.
    fireEvent.change(field, { target: { value: "bin" } });
    expect((field as HTMLInputElement).value).toBe("ben");

    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("The answer: bin")).toBeTruthy();
    // Labelled as the learner's, apart from the answer the alert names.
    expect(screen.getByText("Your answer")).toBeTruthy();
    expect(submitAttempt.mock.calls.map(([input]) => input.response)).toEqual([
      { text: "ben" },
      { text: "ben" },
    ]);
  });

  test("keeps Show answer focused and saying it is loading until the answer comes", async () => {
    let graded!: (grade: Grade) => void;
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => typedActivity,
      submitAttempt: () => new Promise((resolve) => (graded = resolve)),
    });

    const field = await screen.findByRole("textbox", { name: "I am tired: Ich ___ müde." });
    fireEvent.change(field, { target: { value: "bi" } });
    const show = screen.getByRole("button", { name: "Show answer" });
    show.focus();
    fireEvent.click(show);
    expect(show.textContent).toBe("Loading…");
    expect(show.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(show);

    graded({ kind: "typed", outcome: "failure", correctAnswer: "bin" });
    expect(await screen.findByText("Here it is")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Loading…" })).toBeNull();
    // What was typed was not sent, so it is neither shown nor marked wrong.
    expect((field as HTMLInputElement).value).toBe("");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
  });

  test("shows the answer when asked, before any is given, as a failure Braivo records", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => ({ kind: "choice", outcome: "failure", correctChoice: 0 }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Show answer" }));

    expect(await screen.findByText("Here it is")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("The answer: hablé")).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledWith(
      { courseId: "c1", id: expect.any(String), taskId: "t1", response: { reveal: true } },
      { signal: expect.any(AbortSignal) },
    );
    // Asked once: no answer after it, nor asking again.
    expect(screen.getByRole("button", { name: "hablo" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "Show answer" })).toBeNull();
  });

  test("on Continue, rechecks the session and reloads the course, not the brand", async () => {
    const hostOrganization = vi.fn(async () => ({ name: "Fernwood" }));
    const session = vi.fn(async () => ({ id: "ada", name: "Ada Learner" }));
    const { learnerCourseByNumber, learnerProgress, nextActivity } = renderAt("/c/4732", {
      signedIn: true,
      hostOrganization,
      session,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    for (const read of [session, learnerCourseByNumber, nextActivity]) {
      expect(read).toHaveBeenCalledTimes(2);
    }
    // Also read once the answer was graded, before Continue.
    expect(learnerProgress).toHaveBeenCalledTimes(3);
    expect(hostOrganization).toHaveBeenCalledTimes(1);
  });

  test("shows the passages a graded task was written from, linking the ones with a link", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => ({
        kind: "choice",
        outcome: "failure",
        correctChoice: 0,
        passages: [
          {
            quote: "Hablé con mi madre.",
            source: { title: "El pretérito", url: "https://www.youtube.com/watch?v=abc" },
          },
          { quote: "hablar — to speak", source: { title: "Vocabulario" } },
        ],
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));

    const passages = await screen.findByRole("region", { name: "From your lessons" });
    // With no explanation, the answer is still named.
    expect(screen.getByRole("alert").textContent).toBe("Not quiteThe answer: hablé");
    // Titled on screen too, not only for a screen reader.
    expect(
      within(passages).getByRole("heading", { level: 2, name: "From your lessons" }),
    ).toBeTruthy();
    expect(passages.textContent).toContain("Hablé con mi madre.");
    expect(screen.getByRole("link", { name: "El pretérito" }).getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    // Pasted text has nowhere to link to.
    expect(screen.queryByRole("link", { name: "Vocabulario" })).toBeNull();
    expect(passages.textContent).toContain("Vocabulario");
  });

  test.each([
    ["was lost", new TypeError("Failed to fetch")],
    ["failed on the server", new BraivoError(500, "server error")],
  ])("resends the same answer when it %s", async (_, failure) => {
    let graded!: (grade: Grade) => void;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(new Promise((resolve) => (graded = resolve)));
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    const option = await screen.findByRole("button", { name: "hablé" });
    fireEvent.click(option);
    // Locked while sending, but never disabled, which would drop the focus a
    // keyboard learner needs. (jsdom keeps focus on a disabled button, so this
    // pins the cause.)
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.matches(":disabled")).toBe(false);
    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    // Marked as the learner's answer, with no spinner, since nothing is on its way.
    expect(option.textContent).toContain("Your answer");
    expect(screen.queryByRole("status")).toBeNull();

    // The options stay locked on the answer given: another would conflict
    // with it if it was recorded.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    const retry = screen.getByRole("button", { name: "Send again" });
    expect(document.activeElement).toBe(retry);

    // Every further failure replaces the alert, not only the second; Send
    // again keeps its node and focus.
    for (let resends = 1; resends <= 2; resends++) {
      const alert = screen.getByRole("alert");
      fireEvent.click(retry);
      await vi.waitFor(() => expect(screen.getByRole("alert")).not.toBe(alert));
      expect(screen.getByRole("alert").textContent).toBe("Your answer could not be confirmed.");
      expect(retry.textContent).toBe("Send again");
      expect(document.activeElement).toBe(retry);
    }

    fireEvent.click(retry);
    fireEvent.click(retry);
    // Held while the resend is on its way, and focused still.
    expect(retry.textContent).toBe("Sending…");
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry.matches(":disabled")).toBe(false);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(4);

    graded({ kind: "choice", outcome: "success", correctChoice: 0 });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");

    // The same attempt and answer, so Braivo records it once and answers its
    // grade if the first one arrived.
    const [first, ...resends] = submitAttempt.mock.calls;
    for (const resend of resends) expect(resend[0]).toEqual(first![0]);
  });

  test("answers from the keyboard, by the place an option is shown in", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    await screen.findByText("Past tense of 'hablar'?");

    const question = screen.getByRole("group");
    // Hinted, and hidden from the option's name.
    const hint = screen.getByRole("button", { name: "hablé" }).querySelector("kbd");
    expect(hint?.textContent).toBe("2");
    expect(hint?.getAttribute("aria-hidden")).toBe("true");

    // Not from outside the question, which takes the focus when shown, nor
    // held down, nor with a modifier other than Shift.
    fireEvent.keyDown(document.body, { key: "2" });
    fireEvent.keyDown(question, { key: "2", repeat: true });
    for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
      fireEvent.keyDown(question, { key: "2", [modifier]: true });
    }
    expect(submitAttempt).not.toHaveBeenCalled();

    // "hablé" is shown second but is choice 0: the key picks by place. Shift
    // counts when it types the digit, as on AZERTY.
    expect(document.activeElement).toBe(question);
    fireEvent.keyDown(question, { key: "2", shiftKey: true });
    // Not again while the answer is on its way.
    fireEvent.keyDown(question, { key: "1" });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(submitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ response: { choice: 0 } }),
      expect.anything(),
    );

    // Answered, so the keys choose nothing more.
    fireEvent.keyDown(question, { key: "1" });
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("says why a question comes now", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({
        ...activity,
        decision: {
          objectiveId: "o1",
          modelVersion: "v1",
          intent: "review",
          retrievability: 0.724,
          stability: 3,
        },
      }),
    });

    expect(await screen.findByText("Review · Past tense")).toBeTruthy();
    expect(screen.getByText("Due for review: about 72% likely to recall now.")).toBeTruthy();
    // Read with the question, which takes the focus and so would skip them.
    expect(
      screen.getByRole("group", {
        name: "Past tense of 'hablar'?",
        description: "Review · Past tense Due for review: about 72% likely to recall now.",
      }),
    ).toBeTruthy();
  });

  test("says a task of a kind it cannot answer is not supported here, and sends nothing", async () => {
    const { submitAttempt } = renderAt("/c/4732", {
      signedIn: true,
      // A kind a newer Braivo might send, which this app's types do not know.
      nextActivity: async () =>
        ({
          ...activity,
          task: { id: "t2", kind: "essay", prompt: "I am tired: Ich ___ müde." },
        }) as never,
    });

    const notice = await screen.findByRole("region", {
      name: "This question can't be answered here yet.",
    });
    expect(document.activeElement).toBe(notice);
    expect(within(notice).getByRole("link", { name: "Your courses" }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.queryByText("I am tired: Ich ___ müde.")).toBeNull();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("names the objective that has nothing to practise, without claiming the learner is caught up", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      nextActivity: async () => ({
        decision: activity.decision,
        objective: { id: "o2", title: "Subjunctive" },
      }),
    });

    const notice = await screen.findByRole("region", {
      name: "Nothing to practise right now",
      description: "Subjunctive comes next, but there's no practice for it yet.",
    });
    expect(document.activeElement).toBe(notice);
    expect(screen.queryByText("You're caught up")).toBeNull();
  });

  test("names the course, in its tab too, and leads back to the list", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c0", number: 1000, title: "French", urlLabel: "french" },
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: async () => activity,
    });

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Spanish");
    await vi.waitFor(() => expect(document.title).toBe("Spanish · Fernwood"));
    fireEvent.click(screen.getByRole("link", { name: "Your courses" }));

    expect(await screen.findByRole("link", { name: "French" })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Fernwood"));
  });

  test("names the course alone in its tab on a domain that serves no organization", async () => {
    // By ID, as a number names no course there.
    renderAt(`/c/${SPANISH_ID}`, {
      signedIn: true,
      learnerCourses: async () => [
        { id: SPANISH_ID, number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: async () => activity,
    });

    await vi.waitFor(() => expect(document.title).toBe("Spanish"));
  });

  test("still asks the question when the course's title cannot be read", async () => {
    renderAt(`/c/${SPANISH_ID}`, {
      signedIn: true,
      learnerCourses: async () => {
        throw new TypeError("Failed to fetch");
      },
      nextActivity: async () => activity,
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    await vi.waitFor(() => expect(document.title).toBe("Learning"));
  });

  test("sends one answer, however many options are tapped while it is on its way", async () => {
    let graded!: (grade: Grade) => void;
    const submitAttempt = vi.fn<BraivoClient["submitAttempt"]>(
      () => new Promise((resolve) => (graded = resolve)),
    );
    renderAt("/c/4732", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    graded({ kind: "choice", outcome: "success", correctChoice: 0 });

    expect((await screen.findByRole("alert")).textContent).toBe("Correct");
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("offers to load the course again when loading it failed", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(activity);
    renderAt("/c/4732", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
  });

  test("leads back to the list when loading the course failed", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c0", number: 1000, title: "French", urlLabel: "french" }],
      nextActivity: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    fireEvent.click(await screen.findByRole("link", { name: "Your courses" }));

    expect(await screen.findByRole("link", { name: "French" })).toBeTruthy();
  });

  test("waits for a fresh activity when the learner returns to a course", async () => {
    let loaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(anotherActivity)
      .mockReturnValueOnce(new Promise((resolve) => (loaded = resolve)));
    const { router } = renderAt("/c/4732", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "comí" });
    await router.navigate({ to: "/" });
    void router.navigate({ to: "/c/$courseRef", params: { courseRef: "4732" } });

    // What comes next depends on every answer since, elsewhere too, so the
    // question last shown must not be shown again while the next one loads.
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Past tense of 'comer'?")).toBeNull();

    loaded(undefined);
    expect(await screen.findByText("You're caught up")).toBeTruthy();
  });

  test("offers to load again when loading the next activity failed", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(undefined);
    renderAt("/c/4732", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("You're caught up")).toBeTruthy();
  });

  test("reads a course Braivo will not show as not found, not as caught up, with a way back", async () => {
    renderAt("/c/4732", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c0", number: 1000, title: "French", urlLabel: "french" }],
      nextActivity: async () => {
        throw new BraivoError(404, "not found");
      },
    });

    expect(
      await screen.findByText("This course does not exist, or is not one of yours."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Your courses" }));
    expect(await screen.findByRole("link", { name: "French" })).toBeTruthy();
  });

  test("stops naming a course in its tab once a reload finds it gone", async () => {
    let gone = false;
    renderAt("/c/4732", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
      nextActivity: async () => {
        if (gone) throw new BraivoError(404, "not found");
        return activity;
      },
      submitAttempt: async () => {
        gone = true;
        throw new BraivoError(404, "not found");
      },
    });
    await vi.waitFor(() => expect(document.title).toBe("Spanish · Fernwood"));

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(
      await screen.findByText("This course does not exist, or is not one of yours."),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Fernwood"));
  });
});
