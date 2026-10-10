// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale } from "@braivo/i18n";
import {
  type Activity,
  BraivoError,
  type BraivoClient,
  type Grade,
  type LearnerProgressReport,
} from "@braivo/server/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { ANSWER_DEADLINE_MS, OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS } from "./lib/deadline.ts";
import { createLearnRouter } from "./router.tsx";

afterEach(() => {
  // Also for a deadline test that failed before switching back itself.
  vi.useRealTimers();
  cleanup();
  // Where an unfinished answer is kept across a reload.
  sessionStorage.clear();
});

const activity: Activity = {
  decision: { objectiveId: "o1", modelVersion: "v1", intent: "introduce" },
  objective: { id: "o1", title: "Past tense" },
  task: {
    id: "t1",
    kind: "choice",
    prompt: "Past tense of 'hablar'?",
    // Shown in another order than the author's, where "hablé" is choice 0: what
    // the learn app sends and marks must be the choice, never the position.
    options: [
      { choice: 1, text: "hablo" },
      { choice: 0, text: "hablé" },
    ],
  },
};

const anotherActivity: Activity = {
  decision: {
    objectiveId: "o1",
    modelVersion: "v1",
    intent: "reteach",
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
  },
  objective: { id: "o1", title: "Past tense" },
  task: {
    id: "t2",
    kind: "choice",
    prompt: "Past tense of 'comer'?",
    options: [
      { choice: 0, text: "comí" },
      { choice: 1, text: "como" },
    ],
  },
};

const noProgress: LearnerProgressReport = { modelVersion: "v1", objectives: [] };

/** A request Braivo never answers: it ends only when its signal aborts, as `fetch` does. */
function stall(options?: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Lets `ms` pass on fake timers, so that a stalled request reaches its deadline. */
async function waitOut(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/**
 * The app as a learner reaches it, at `path`, with Braivo and the session
 * stubbed: the route tree is the real one, so gating and loading are too.
 */
function renderAt(
  path: string,
  options: {
    signedIn: boolean;
    learnerCourses?: BraivoClient["learnerCourses"];
    learnerProgress?: BraivoClient["learnerProgress"];
    nextActivity?: BraivoClient["nextActivity"];
    submitAttempt?: BraivoClient["submitAttempt"];
    /** The organization whose domain serves the app; none unless given. */
    hostOrganization?: BraivoClient["hostOrganization"];
    /** Braivo's answer to who is signed in, in place of `signedIn` and `user`. */
    session?: BraivoClient["session"];
    /** Who is signed in, when `signedIn`. */
    user?: { id: string; name: string };
    /** Better Auth's answer on the installation's host, in place of `signedIn`'s. */
    getSession?: (options?: { fetchOptions?: { signal?: AbortSignal } }) => Promise<unknown>;
  },
) {
  const hostOrganization = options.hostOrganization ?? (async () => undefined);
  const learnerCourses = vi.fn(options.learnerCourses ?? (async () => []));
  const learnerProgress = vi.fn(options.learnerProgress ?? (async () => noProgress));
  const nextActivity = vi.fn(options.nextActivity ?? (async () => undefined));
  const submitAttempt = vi.fn(
    options.submitAttempt ?? (async () => ({ outcome: "success" as const, correctChoice: 0 })),
  );
  let signedIn = options.signedIn;
  const user = options.user ?? { id: "ada", name: "Ada Learner" };
  const auth = {
    getSession:
      options.getSession ?? (async () => ({ data: signedIn ? { user } : null, error: null })),
    emailOtp: { sendVerificationOtp: async () => ({ error: null }) },
    signIn: {
      emailOtp: vi.fn(async () => {
        signedIn = true;
        return { data: { user }, error: null };
      }),
    },
  } as unknown as AppContext["auth"];
  const signOut = vi.fn(async () => {
    signedIn = false;
  });
  const braivo = {
    hostOrganization,
    session: options.session ?? (async () => (signedIn ? user : undefined)),
    signOut,
    learnerCourses,
    learnerProgress,
    nextActivity,
    submitAttempt,
  } as unknown as AppContext["braivo"];
  const visit = vi.fn<AppContext["visit"]>();

  const router = createLearnRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, braivo, visit },
  });
  render(<RouterProvider router={router} />);

  return { learnerCourses, learnerProgress, nextActivity, submitAttempt, router, signOut, visit };
}

describe("the learn app", () => {
  test("sends a signed-out learner to sign in, and asks Braivo nothing", async () => {
    const { learnerProgress, nextActivity, router } = renderAt("/courses/c1", {
      signedIn: false,
    });

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/courses/c1" });
    expect(nextActivity).not.toHaveBeenCalled();
    expect(learnerProgress).not.toHaveBeenCalled();
  });

  test("says so when the session cannot be checked, asking Braivo nothing more, until tried again", async () => {
    let down = true;
    const { learnerCourses, router } = renderAt("/", {
      signedIn: true,
      session: async () => {
        if (down) throw new TypeError("Failed to fetch");
        return { id: "ada", name: "Ada Learner" };
      },
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
    });

    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(learnerCourses).not.toHaveBeenCalled();

    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("on its organization's domain, leaves to sign in on the installation's origin, to come back here", async () => {
    const { visit } = renderAt("/courses/c1?tab=next", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    // Wearing the organization's brand meanwhile, and taking no code here.
    expect(await screen.findByText("Fernwood")).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Fernwood"));
    expect(visit).toHaveBeenCalledWith(
      `/api/session/sign-in?redirect=${encodeURIComponent("/courses/c1?tab=next")}`,
    );
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  test("on its organization's domain, sends a learner already signed in onward, without a second handoff", async () => {
    const { router, visit } = renderAt("/login?redirect=%2Fcourses%2Fc1", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/courses/c1"));
    expect(visit).not.toHaveBeenCalled();
    await router.navigate({ to: "/login", search: { redirect: "/" } });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));

    // The router puts a redirect in `/login`'s place, so Back moves past it.
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/courses/c1"));
  });

  test("on its organization's domain, hands an unnamed learner off again, to be named there", async () => {
    const { visit } = renderAt("/login", {
      signedIn: true,
      user: { id: "ada", name: "" },
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F"));
  });

  test("on its organization's domain, after a failed handoff, hands off again only on a click", async () => {
    const { visit } = renderAt("/login?failed=1", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    const notice = await screen.findByRole("region", { name: "This sign-in did not finish." });
    expect(document.activeElement).toBe(notice);
    expect(visit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    // Where the failed sign-in was headed is not known here.
    expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F");
  });

  test.each(["the host's organization", "the session"])(
    "offers to try again when Braivo does not answer %s in time on sign-in",
    async (stalled) => {
      let answering = false;
      const fernwood = { name: "Fernwood" };
      vi.useFakeTimers();
      const { visit } = renderAt("/login", {
        signedIn: false,
        hostOrganization: (options) =>
          answering || stalled !== "the host's organization"
            ? Promise.resolve(fernwood)
            : stall(options),
        session: (options) =>
          answering || stalled !== "the session" ? Promise.resolve(undefined) : stall(options),
      });
      await waitOut(READ_DEADLINE_MS);
      // The root's brand, read next, stalls as well, and is left out at its own deadline.
      await waitOut(OPTIONAL_READ_DEADLINE_MS);
      vi.useRealTimers();

      answering = true;
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await vi.waitFor(() =>
        expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F"),
      );
    },
  );

  test("offers the code form on the installation's host when the session cannot be read in time", async () => {
    vi.useFakeTimers();
    renderAt("/login", {
      signedIn: false,
      getSession: (options) => stall(options?.fetchOptions),
    });
    await waitOut(READ_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
  });

  test("signs in in the browser's language, on every view of the way", async () => {
    onTestFinished(() => activateLocale("en"));
    await activateLocale(chooseLocale(["pl-PL", "en"]));
    const fernwood = async () => ({ name: "Fernwood" });

    renderAt("/login", { signedIn: false });
    expect(await screen.findByRole("heading", { name: "Zaloguj się" })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Nauka"));
    expect(screen.getByLabelText("Adres e-mail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wyślij mi kod" })).toBeTruthy();
    cleanup();

    renderAt("/login", { signedIn: false, hostOrganization: fernwood });
    expect(await screen.findByRole("status", { name: "Logowanie" })).toBeTruthy();
    cleanup();

    renderAt("/login?failed=1", { signedIn: false, hostOrganization: fernwood });
    expect(
      await screen.findByRole("region", { name: "To logowanie nie zostało dokończone." }),
    ).toBeTruthy();
    expect(screen.getByText("Mogło wygasnąć.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zaloguj się ponownie" })).toBeTruthy();
    cleanup();

    renderAt("/login", {
      signedIn: false,
      hostOrganization: async () => {
        throw new BraivoError(500, "down");
      },
    });
    expect(await screen.findByRole("region", { name: "Coś poszło nie tak." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("pl");
  });

  test("on its organization's domain, after a failed handoff, sends a learner signed in meanwhile onward", async () => {
    const { router } = renderAt("/login?failed=1", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByText("This sign-in did not finish.")).toBeNull();
  });

  test("on its organization's domain, leaves only on navigating to sign in, not on a preload", async () => {
    const { router, signOut, visit } = renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    // Signed out behind the page's back, so `/login` would hand off.
    await signOut();

    await router.preloadRoute({ to: "/login" });
    expect(visit).not.toHaveBeenCalled();

    await router.navigate({ to: "/login" });
    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F"));
  });

  test("signs a learner out of this domain, then back to sign in", async () => {
    const { signOut, visit } = renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F"));
    expect(signOut).toHaveBeenCalledOnce();
  });

  test("lets a learner try signing out again when Braivo does not answer in time", async () => {
    const { router, signOut } = renderAt("/", { signedIn: true });
    signOut.mockImplementationOnce((options?: { signal?: AbortSignal }) => stall(options));
    const button = await screen.findByRole("button", { name: "Sign out" });

    vi.useFakeTimers();
    fireEvent.click(button);
    await waitOut(READ_DEADLINE_MS);
    vi.useRealTimers();

    // Never shown as signed out, since it may not be: the account stays, and so does the page.
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(router.state.location.pathname).toBe("/");
  });

  test("says when a learner could not be signed out, and lets them try again", async () => {
    const { router, signOut } = renderAt("/", { signedIn: true });
    const failing = Promise.withResolvers<void>();
    signOut.mockReturnValueOnce(failing.promise);

    const button = await screen.findByRole("button", { name: "Sign out" });
    fireEvent.click(button);
    // Locked while it is sent, but never disabled, which would drop the focus.
    fireEvent.click(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.matches(":disabled")).toBe(false);
    expect(signOut).toHaveBeenCalledOnce();
    failing.reject(new Error("Braivo answered 500 signing out"));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(router.state.location.pathname).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  test("shows no brand on a domain that serves no organization", async () => {
    document.title = "";
    renderAt("/login", { signedIn: false });

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(screen.queryByText("Fernwood")).toBeNull();
    await vi.waitFor(() => expect(document.title).toBe("Learning"));
  });

  test("stays usable, unbranded, when the brand cannot be read", async () => {
    renderAt("/", {
      signedIn: true,
      hostOrganization: async () => {
        throw new BraivoError(500, "down");
      },
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
    });

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("offers no way to sign in where it cannot tell which host it is on", async () => {
    // The emailed-code form works only on the installation's host, and a
    // learn domain whose lookup failed may be anything else.
    let down = true;
    const { visit } = renderAt("/login", {
      signedIn: false,
      hostOrganization: async () => {
        if (down) throw new BraivoError(500, "down");
        return { name: "Fernwood" };
      },
    });

    const notice = await screen.findByRole("region", { name: "Something went wrong." });
    expect(document.activeElement).toBe(notice);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(visit).not.toHaveBeenCalled();

    // Until it is tried again, once the lookup can answer.
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2F"));
  });

  test("signs a learner in with an emailed code, and returns them where they were headed", async () => {
    const { learnerCourses, router } = renderAt("/", {
      signedIn: false,
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
    });

    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    const code = await screen.findByLabelText("Code");
    // No link: an emailed code makes the account, so there is nothing to sign up for.
    expect(screen.queryByRole("link")).toBeNull();
    // Its last digit signs in.
    fireEvent.change(code, { target: { value: "123456" } });

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(learnerCourses).toHaveBeenCalled();
  });

  test("lists the learner's courses, each a way into it", async () => {
    const { learnerCourses, router } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
      nextActivity: async () => activity,
    });

    const link = await screen.findByRole("link", { name: "Spanish" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(learnerCourses).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    fireEvent.click(link);

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/courses/c1");
  });

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

  test("asks the task, grades the answer, and moves on", async () => {
    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
      submitAttempt: async () => ({
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
    expect(screen.getByText("You missed this last time.")).toBeTruthy();
  });

  test("on Continue, rechecks the session and reloads the course, not the brand", async () => {
    const hostOrganization = vi.fn(async () => ({ name: "Fernwood" }));
    const session = vi.fn(async () => ({ id: "ada", name: "Ada Learner" }));
    const { learnerCourses, learnerProgress, nextActivity } = renderAt("/courses/c1", {
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
    for (const read of [session, nextActivity, learnerProgress, learnerCourses]) {
      expect(read).toHaveBeenCalledTimes(2);
    }
    expect(hostOrganization).toHaveBeenCalledTimes(1);
  });

  test("shows the passages a graded task was written from, linking the ones with a link", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => ({
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
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

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

    graded({ outcome: "success", correctChoice: 0 });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");

    // The same attempt and answer, so Braivo records it once and answers its
    // grade if the first one arrived.
    const [first, ...resends] = submitAttempt.mock.calls;
    for (const resend of resends) expect(resend[0]).toEqual(first![0]);
  });

  test("shows an answer's feedback after a reload while it was on its way, sending the same attempt", async () => {
    const before = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();

    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      // The answer was recorded, so Braivo has moved on.
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => ({
        outcome: "failure",
        correctChoice: 0,
        explanation: "Preterite.",
      }),
    });

    // The task answered, not the next one, graded as before the reload.
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("Preterite.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Correct/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablo.*Your answer/ })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    expect(submitAttempt.mock.calls[0]![0]).toEqual(before.submitAttempt.mock.calls[0]![0]);
    expect(nextActivity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    cleanup();

    // Continued past, it is not sent again.
    const after = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
    });
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(after.submitAttempt).not.toHaveBeenCalled();
  });

  test("after a reload, resends an answer that could not be confirmed, and offers to send it again", async () => {
    const lost = async () => {
      throw new TypeError("Failed to fetch");
    };
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: lost,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    cleanup();

    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockImplementationOnce(lost)
      .mockResolvedValueOnce({ outcome: "success", correctChoice: 0 });
    renderAt("/courses/c1", { signedIn: true, submitAttempt });

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Your answer/ })).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Send again" });
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test("offers to send an answer again when Braivo does not answer in time", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockImplementationOnce((_input, options) => stall(options))
      .mockResolvedValueOnce({ outcome: "success", correctChoice: 0 });
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });
    const option = await screen.findByRole("button", { name: "hablé" });

    vi.useFakeTimers();
    fireEvent.click(option);
    await waitOut(ANSWER_DEADLINE_MS - 1);
    expect(screen.queryByText("Your answer could not be confirmed.")).toBeNull();
    await waitOut(1);
    vi.useRealTimers();

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test("after a reload, offers to send again an answer whose resend Braivo does not answer in time", async () => {
    const before = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    await vi.waitFor(() => expect(before.submitAttempt).toHaveBeenCalledTimes(1));
    cleanup();

    vi.useFakeTimers();
    renderAt("/courses/c1", {
      signedIn: true,
      submitAttempt: (_input, options) => stall(options),
    });
    await waitOut(ANSWER_DEADLINE_MS);
    vi.useRealTimers();

    expect(await screen.findByText("Your answer could not be confirmed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /hablé.*Your answer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
  });

  test.each([
    ["the brand", { hostOrganization: (options) => stall(options) }],
    ["the summary", { learnerProgress: (_input, options) => stall(options) }],
    ["the title", { learnerCourses: (options) => stall(options) }],
  ] satisfies [string, Partial<BraivoClient>][])(
    "asks the question without %s when Braivo does not answer it in time",
    async (_, stubs) => {
      vi.useFakeTimers();
      renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, ...stubs });
      // Held back meanwhile, so the page does not shift when it arrives.
      await waitOut(OPTIONAL_READ_DEADLINE_MS - 1);
      expect(screen.queryByText("Past tense of 'hablar'?")).toBeNull();
      await waitOut(1);
      vi.useRealTimers();

      expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    },
  );

  test("gives the question its own deadline, not the shorter one of what it shows without", async () => {
    vi.useFakeTimers();
    renderAt("/courses/c1", {
      signedIn: true,
      learnerProgress: (_input, options) => stall(options),
      // Slower than the summary's deadline, within its own.
      nextActivity: (_courseId, options) =>
        Promise.race([
          new Promise<Activity>((resolve) => setTimeout(() => resolve(activity), 5_000)),
          stall(options),
        ]),
    });
    await waitOut(5_000);
    vi.useRealTimers();

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
  });

  test.each([
    [
      "the next question",
      {
        nextActivity: vi
          .fn<BraivoClient["nextActivity"]>()
          .mockResolvedValueOnce(activity)
          .mockImplementationOnce((_courseId, options) => stall(options))
          .mockResolvedValue(anotherActivity),
      },
      // The course page's Try again reloads the course alone.
      1,
    ],
    [
      "the session",
      {
        nextActivity: vi
          .fn<BraivoClient["nextActivity"]>()
          .mockResolvedValueOnce(activity)
          .mockResolvedValue(anotherActivity),
        session: vi
          .fn<BraivoClient["session"]>()
          .mockResolvedValueOnce({ id: "ada", name: "Ada Learner" })
          .mockImplementationOnce((options) => stall(options))
          .mockResolvedValue({ id: "ada", name: "Ada Learner" }),
      },
      // The guard's failure is the app's, whose Try again reloads everything.
      2,
    ],
  ])(
    "offers to try again when Braivo does not answer %s in time on Continue",
    async (_, stubs, brandReads) => {
      const hostOrganization = vi.fn(async () => ({ name: "Fernwood" }));
      renderAt("/courses/c1", { signedIn: true, hostOrganization, ...stubs });
      fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
      const next = await screen.findByRole("button", { name: "Continue" });

      vi.useFakeTimers();
      fireEvent.click(next);
      await waitOut(READ_DEADLINE_MS);
      vi.useRealTimers();

      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(hostOrganization).toHaveBeenCalledTimes(brandReads);
    },
  );

  test.each([400, 403, 404, 409, 413])(
    "after a reload, forgets an answer refused with %i and loads the course as usual",
    async (status) => {
      renderAt("/courses/c1", {
        signedIn: true,
        nextActivity: async () => activity,
        submitAttempt: () => new Promise(() => {}),
      });
      fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
      cleanup();

      const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
        submitAttempt: async () => {
          throw new BraivoError(status, "refused");
        },
      });
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(submitAttempt).toHaveBeenCalledTimes(1);
      expect(nextActivity).toHaveBeenCalledTimes(1);
      cleanup();

      const again = renderAt("/courses/c1", {
        signedIn: true,
        nextActivity: async () => anotherActivity,
      });
      expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
      expect(again.submitAttempt).not.toHaveBeenCalled();
    },
  );

  test("does not resend an answer refused before the reload", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => {
        throw new BraivoError(400, "refused");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    cleanup();

    const { submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("sends a learner whose session ended during a reload to sign in, keeping their answer for after", async () => {
    const before = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    let signedIn = true;
    const { router } = renderAt("/courses/c1", {
      signedIn: true,
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      submitAttempt: async () => {
        signedIn = false;
        throw new BraivoError(401, "no session");
      },
    });
    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    cleanup();

    const after = renderAt("/courses/c1", { signedIn: true });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    expect(after.submitAttempt.mock.calls[0]![0]).toEqual(before.submitAttempt.mock.calls[0]![0]);
  });

  test("shows a graded answer's feedback again after a reload, until the learner continues", async () => {
    const graded = { outcome: "failure" as const, correctChoice: 0, explanation: "Preterite." };
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: async () => graded,
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    expect(await screen.findByText("Not quite")).toBeTruthy();
    cleanup();

    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => graded,
    });
    expect(await screen.findByText("Not quite")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("Preterite.")).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(nextActivity).not.toHaveBeenCalled();
  });

  test("resends an unfinished answer on a visit, never on a preload", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    const { router, submitAttempt } = renderAt("/", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    await screen.findByRole("heading", { name: "Your courses" });
    await router.preloadRoute({ to: "/courses/$courseId", params: { courseId: "c1" } });
    expect(submitAttempt).not.toHaveBeenCalled();

    await router.navigate({ to: "/courses/$courseId", params: { courseId: "c1" } });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("shows the grade a reload finds after a 401 from a session that still holds", async () => {
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockRejectedValueOnce(new BraivoError(401, "no session"))
      .mockResolvedValueOnce({ outcome: "success", correctChoice: 0 });
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Correct");
    const [first, second] = submitAttempt.mock.calls;
    expect(second![0]).toEqual(first![0]);
  });

  test.each([
    ["no decision", { ...activity, decision: undefined }],
    ["an intent it does not know", { ...activity, decision: { intent: "drill" } }],
    ["an option it cannot read", { ...activity, task: { ...activity.task, options: [null] } }],
  ])("ignores an unfinished answer with %s, loading the course as usual", async (_, saved) => {
    sessionStorage.setItem(
      "braivo.unfinishedAttempt:ada:c1",
      JSON.stringify({ id: "a1", response: { choice: 0 }, activity: saved }),
    );
    const { nextActivity, submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
    expect(nextActivity).toHaveBeenCalledTimes(1);
  });

  test("keeps an unfinished answer whose resend was abandoned by leaving, whatever it came to", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    let refuse!: (error: unknown) => void;
    const submitAttempt = vi
      .fn<BraivoClient["submitAttempt"]>()
      .mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce({ outcome: "success", correctChoice: 0 });
    const { router } = renderAt("/courses/c1", { signedIn: true, submitAttempt });
    await vi.waitFor(() => expect(submitAttempt).toHaveBeenCalledTimes(1));
    await router.navigate({ to: "/" });
    // Settling after the page was left, it decides nothing.
    refuse(new BraivoError(409, "resting"));

    await router.navigate({ to: "/courses/$courseId", params: { courseId: "c1" } });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(submitAttempt).toHaveBeenCalledTimes(2);
  });

  test("never resends one learner's answer as another's", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: () => new Promise(() => {}),
    });
    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    cleanup();

    const { submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      user: { id: "grace", name: "Grace Learner" },
      nextActivity: async () => activity,
    });
    expect(await screen.findByRole("button", { name: "hablé" })).toBeTruthy();
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  test("holds Continue while the next activity loads, so a second press does not restart it", async () => {
    let loaded!: (next: Activity | undefined) => void;
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockReturnValueOnce(new Promise((resolve) => (loaded = resolve)));
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    const next = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(next);
    fireEvent.click(next);

    expect(next.textContent).toBe("Loading…");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.matches(":disabled")).toBe(false);
    await vi.waitFor(() => expect(nextActivity).toHaveBeenCalledTimes(2));

    loaded(undefined);
    expect(await screen.findByText("You're caught up")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  test.each([400, 403, 413])(
    "gives up on an answer Braivo refuses with %i, rather than inviting another choice",
    async (status) => {
      renderAt("/courses/c1", {
        signedIn: true,
        nextActivity: async () => activity,
        submitAttempt: async () => {
          throw new BraivoError(status, "refused");
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

      const notice = await screen.findByRole("region", { name: "Something went wrong." });
      expect(document.activeElement).toBe(notice);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

  test("sends a learner whose session ended to sign in, rather than asking them to retry", async () => {
    let signedIn = true;
    const auth = {
      getSession: async () => ({ data: null, error: null }),
    } as unknown as AppContext["auth"];
    const braivo = {
      hostOrganization: async () => undefined,
      session: async () => (signedIn ? { id: "ada", name: "Ada Learner" } : undefined),
      learnerCourses: async () => [],
      learnerProgress: async () => noProgress,
      nextActivity: async () => activity,
      submitAttempt: async () => {
        signedIn = false;
        throw new BraivoError(401, "no session");
      },
    } as unknown as AppContext["braivo"];
    const router = createLearnRouter({
      history: createMemoryHistory({ initialEntries: ["/courses/c1"] }),
      context: { auth, braivo, visit: () => {} },
    });
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  test("says when a just-answered task comes back, and asks again then", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 0.05 })
      .mockResolvedValueOnce(activity);
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    const notice = await screen.findByRole("region", { name: "Take a short break" });
    expect(document.activeElement).toBe(notice);
    expect(notice.textContent).toContain("You practised Past tense recently.");

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(nextActivity).toHaveBeenCalledTimes(2);
  });

  // From 10:00:00: never early, nor a minute late on the minute itself.
  test.each([
    [340, "10:06"],
    [300, "10:05"],
  ])("says when practice continues, %is on, as %s", async (retryAfter, shown) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-01T10:00:00.000Z"));
    onTestFinished(() => now.mockRestore());
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => ({ objective: activity.objective, retryAfter }),
    });

    const notice = await screen.findByRole("region", { name: "Take a short break" });
    const when = new Date(`2026-06-01T${shown}:00.000Z`).toLocaleTimeString("en", {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(notice.textContent).toContain(`Practice continues at ${when},`);
  });

  test("asks a returning task afresh, in the order it comes back in", async () => {
    const reshuffled: Activity = {
      ...activity,
      task: { ...activity.task, options: activity.task.options.toReversed() },
    };
    const { submitAttempt } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 0.05 })
        .mockResolvedValueOnce(reshuffled),
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Unanswered, though it is the same task: nothing carries over.
    await screen.findByRole("region", { name: "Take a short break" });
    const [first, second] = await screen.findAllByRole("button", { name: /^habl/ });
    expect(first).toBe(screen.getByRole("button", { name: "hablé" }));
    expect(second!.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(first!);

    const [before, after] = submitAttempt.mock.calls.map(([input]) => input!);
    expect(after).toMatchObject({ taskId: "t1", response: { choice: 0 } });
    expect(after!.id).not.toBe(before!.id);
  });

  test("rests a task answered moments ago elsewhere, rather than asking again", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce({ objective: activity.objective, retryAfter: 600 });
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity,
      submitAttempt: async () => {
        throw new BraivoError(409, "resting");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Take a short break")).toBeTruthy();
  });

  test("shows the learner where they stand in the course, read as themselves", async () => {
    const at = "2026-06-01T00:00:00.000Z";
    const { learnerProgress } = renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => ({
        modelVersion: "v1",
        objectives: [
          {
            objectiveId: "a",
            title: "Greetings",
            phase: "retaining",
            lastEvidenceAt: at,
            stability: 3,
            retrievability: 0.95,
            due: false,
            dueAt: "2026-06-04T00:00:00.001Z",
            evidence: [{ outcome: "success", at }],
          },
          {
            objectiveId: "b",
            title: "Numbers",
            phase: "retaining",
            lastEvidenceAt: at,
            stability: 1,
            retrievability: 0.5,
            due: true,
            dueAt: "2026-06-02T00:00:00.001Z",
            evidence: [{ outcome: "success", at }],
          },
          {
            objectiveId: "c",
            title: "Colours",
            phase: "acquiring",
            lastEvidenceAt: at,
            evidence: [{ outcome: "failure", at }],
          },
          { objectiveId: "d", title: "Days", phase: "unseen", evidence: [] },
          { objectiveId: "e", title: "Months", phase: "unseen", evidence: [] },
        ],
      }),
    });

    const summary = await screen.findByText(
      "1 retained · 1 due for review · 1 learning · 2 not started",
    );
    // Which is which opens from the counts, by name.
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(
      within(details)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Greetings: retained",
      "Numbers: due for review",
      "Colours: learning",
      "Days: not started",
      "Months: not started",
    ]);
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "c1", learnerId: "ada" },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("leaves out empty counts", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => ({
        modelVersion: "v1",
        objectives: [
          { objectiveId: "a", title: "Greetings", phase: "unseen", evidence: [] },
          { objectiveId: "b", title: "Numbers", phase: "unseen", evidence: [] },
        ],
      }),
    });

    expect(await screen.findByText("2 not started")).toBeTruthy();
  });

  test("says how practice goes until an objective starts", async () => {
    const hint =
      "One question at a time. What you get wrong comes back soon; what you get right returns for review before you're likely to forget it.";
    type Standing = LearnerProgressReport["objectives"][number];
    const pastTense: Standing = {
      objectiveId: "o1",
      title: "Past tense",
      phase: "unseen",
      evidence: [],
    };
    const greetings: Standing = { ...pastTense, objectiveId: "o2", title: "Greetings" };
    let reported: Standing[] = [pastTense, greetings];
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: vi
        .fn<BraivoClient["nextActivity"]>()
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(anotherActivity),
      learnerProgress: async () => ({ modelVersion: "v1", objectives: reported }),
      submitAttempt: async () => ({ outcome: "failure", correctChoice: 0 }),
    });

    // Read with the question, which takes the focus.
    expect(
      await screen.findByRole("group", {
        name: "Past tense of 'hablar'?",
        description: `New · Past tense ${hint}`,
      }),
    ).toBeTruthy();

    // A wrong answer starts the objective; once Continue reloads progress, the line goes.
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    reported = [
      {
        ...pastTense,
        phase: "acquiring",
        lastEvidenceAt: "2026-06-01T00:00:00.000Z",
        evidence: [{ outcome: "failure", at: "2026-06-01T00:00:00.000Z" }],
      },
      greetings,
    ];
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "comí" })).toBeTruthy();
    expect(screen.queryByText(hint)).toBeNull();
    cleanup();

    // No objectives reported: nothing to say.
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => noProgress,
    });
    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByText(hint)).toBeNull();
  });

  test("still asks the question when where they stand cannot be read", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => {
        throw new BraivoError(500, "unavailable");
      },
    });

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
    expect(screen.queryByText(/^One question at a time/)).toBeNull();
  });

  test("answers from the keyboard, by the place an option is shown in", async () => {
    const { submitAttempt } = renderAt("/courses/c1", {
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
    renderAt("/courses/c1", {
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

  test("tells a learner with nothing due that they are caught up", async () => {
    renderAt("/courses/c1", { signedIn: true });

    const notice = await screen.findByRole("region", {
      name: "You're caught up",
      description: "Nothing is due right now.",
    });
    expect(document.activeElement).toBe(notice);
  });

  test("tells a caught-up learner when their next review falls due, and of what", async () => {
    const retained = (objectiveId: string, title: string, dueAt: string, due = false) => ({
      objectiveId,
      title,
      phase: "retaining" as const,
      lastEvidenceAt: "2026-06-01T00:00:00.000Z",
      stability: 1,
      retrievability: due ? 0.5 : 0.95,
      due,
      dueAt,
      evidence: [{ outcome: "success" as const, at: "2026-06-01T00:00:00.000Z" }],
    });
    renderAt("/courses/c1", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        objectives: [
          retained("a", "Greetings", "2026-06-09T00:00:00.000Z"),
          // Shown rounded up, never early.
          retained("b", "Numbers", "2026-06-05T09:30:00.001Z"),
          // Due by the report, read a moment after the activity: its time has passed.
          retained("c", "Colours", "2026-06-02T00:00:00.000Z", true),
        ],
      }),
    });

    const when = new Date("2026-06-05T09:31:00.000Z").toLocaleString("en", {
      dateStyle: "full",
      timeStyle: "short",
    });
    expect(
      await screen.findByRole("region", {
        name: "You're caught up",
        description: `Nothing is due right now. Next review due: Numbers, on ${when}.`,
      }),
    ).toBeTruthy();
  });

  test("names the objective that has nothing to practise, without claiming the learner is caught up", async () => {
    renderAt("/courses/c1", {
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
    renderAt("/courses/c1", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c0", title: "French" },
        { id: "c1", title: "Spanish" },
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
    renderAt("/courses/c1", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
      nextActivity: async () => activity,
    });

    await vi.waitFor(() => expect(document.title).toBe("Spanish"));
  });

  test("still asks the question when the course's title cannot be read", async () => {
    renderAt("/courses/c1", {
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

  test("offers to load the course list again when loading it failed", async () => {
    const learnerCourses = vi
      .fn<BraivoClient["learnerCourses"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([{ id: "c1", title: "Spanish" }]);
    renderAt("/", { signedIn: true, learnerCourses });

    const notice = await screen.findByRole("region", { name: "Your courses could not be loaded." });
    expect(document.activeElement).toBe(notice);
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("shows that a page slow to load is on its way, under the header", async () => {
    const loading = Promise.withResolvers<Activity | undefined>();
    renderAt("/", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
      nextActivity: () => loading.promise,
    });
    fireEvent.click(await screen.findByRole("link", { name: "Spanish" }));

    expect(await screen.findByRole("status", { name: "Loading" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    loading.resolve(activity);
    expect(await screen.findByRole("button", { name: "hablé" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  test("sends one answer, however many options are tapped while it is on its way", async () => {
    let graded!: (grade: Grade) => void;
    const submitAttempt = vi.fn<BraivoClient["submitAttempt"]>(
      () => new Promise((resolve) => (graded = resolve)),
    );
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity, submitAttempt });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));
    graded({ outcome: "success", correctChoice: 0 });

    expect((await screen.findByRole("alert")).textContent).toBe("Correct");
    expect(submitAttempt).toHaveBeenCalledTimes(1);
  });

  test("offers to load the course again when loading it failed", async () => {
    const nextActivity = vi
      .fn<BraivoClient["nextActivity"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(activity);
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Past tense of 'hablar'?")).toBeTruthy();
  });

  test("leads back to the list when loading the course failed", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c0", title: "French" }],
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
    const { router } = renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "comí" });
    await router.navigate({ to: "/" });
    void router.navigate({ to: "/courses/$courseId", params: { courseId: "c1" } });

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
    renderAt("/courses/c1", { signedIn: true, nextActivity });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("You're caught up")).toBeTruthy();
  });

  test("reads a course Braivo will not show as not found, not as caught up, with a way back", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      learnerCourses: async () => [{ id: "c0", title: "French" }],
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
    renderAt("/courses/c1", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [{ id: "c1", title: "Spanish" }],
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

describe("the learn app in Polish", () => {
  beforeEach(async () => {
    await activateLocale(chooseLocale(["pl-PL", "en"]));
    // Half an hour off UTC, so a time shown in UTC, or rounded to the hour, fails.
    vi.stubEnv("TZ", "Asia/Kolkata");
    return () => {
      vi.unstubAllEnvs();
      return activateLocale("en");
    };
  });

  const notStarted = (count: number): LearnerProgressReport => ({
    modelVersion: "v1",
    objectives: Array.from({ length: count }, (_, index) => ({
      objectiveId: `o${index}`,
      title: `Objective ${index}`,
      phase: "unseen" as const,
      evidence: [],
    })),
  });

  test("lists the courses, and leads from a path that names nothing back to them", async () => {
    renderAt("/elsewhere", { signedIn: true });

    expect(await screen.findByRole("region", { name: "Nic tu nie ma." })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Nauka"));
    fireEvent.click(screen.getByRole("link", { name: "Twoje kursy" }));

    expect(await screen.findByRole("heading", { name: "Twoje kursy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wyloguj się" })).toBeTruthy();
    expect(screen.getByText("Nie masz jeszcze kursów")).toBeTruthy();
  });

  test("says when the courses, a course, or signing out failed", async () => {
    const { signOut } = renderAt("/", {
      signedIn: true,
      learnerCourses: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const notice = await screen.findByRole("region", {
      name: "Nie udało się wczytać Twoich kursów.",
    });
    expect(within(notice).getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
    signOut.mockRejectedValueOnce(new Error("Braivo answered 500 signing out"));
    fireEvent.click(screen.getByRole("button", { name: "Wyloguj się" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Nie udało się wylogować. Spróbuj ponownie.",
    );
    cleanup();

    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const failed = await screen.findByRole("region", { name: "Coś poszło nie tak." });
    expect(within(failed).getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
    expect(within(failed).getByRole("link", { name: "Twoje kursy" })).toBeTruthy();
  });

  test("introduces a new topic, and grades a right answer", async () => {
    renderAt("/courses/c1", { signedIn: true, nextActivity: async () => activity });

    expect(await screen.findByText("Nowy temat · Past tense")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "hablé" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Dobrze");
    expect(screen.getByRole("button", { name: "hablé Poprawna" })).toBeTruthy();
  });

  test("says why a missed topic comes again, and when an answer is refused", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => anotherActivity,
      submitAttempt: async () => {
        throw new BraivoError(400, "invalid");
      },
    });

    expect(await screen.findByText("Jeszcze raz · Past tense")).toBeTruthy();
    expect(screen.getByText("Ostatnim razem się nie udało.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "comí" }));

    expect(await screen.findByRole("region", { name: "Coś poszło nie tak." })).toBeTruthy();
  });

  test("asks the task and grades the answer", async () => {
    renderAt("/courses/c1", {
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
      submitAttempt: async () => ({
        outcome: "failure",
        correctChoice: 0,
        passages: [{ quote: "Hablé con mi madre.", source: { title: "Libro" }, page: "12" }],
      }),
    });

    expect(
      await screen.findByRole("group", {
        name: "Past tense of 'hablar'?",
        description:
          "Powtórka · Past tense Czas na powtórkę: masz około 72% szans, że teraz sobie przypomnisz.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Twoje kursy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "hablo" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Nie tym razem")).toBeTruthy();
    expect(within(alert).getByText("Poprawna odpowiedź: hablé")).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablé Poprawna" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablo Twoja odpowiedź" })).toBeTruthy();
    const passages = screen.getByRole("region", { name: "Z Twoich lekcji" });
    expect(within(passages).getByText("Libro · s. 12")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dalej" })).toBeTruthy();
  });

  test("says when an answer could not be confirmed, and resends it", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      submitAttempt: vi
        .fn<BraivoClient["submitAttempt"]>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockReturnValueOnce(new Promise(() => {})),
    });

    fireEvent.click(await screen.findByRole("button", { name: "hablé" }));

    expect(await screen.findByText("Nie udało się potwierdzić Twojej odpowiedzi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "hablé Twoja odpowiedź" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wyślij ponownie" }));
    expect(screen.getByRole("button", { name: "Wysyłanie…" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Ładowanie" })).toBeTruthy();
  });

  test("rests a just-answered task until a time written the Polish way, in the browser's time zone", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-01T10:00:00.000Z"));
    onTestFinished(() => now.mockRestore());
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => ({ objective: activity.objective, retryAfter: 340 }),
    });

    expect(
      await screen.findByRole("region", {
        name: "Zrób krótką przerwę",
        description:
          "Temat „Past tense” był niedawno ćwiczony. Ćwiczenia wznowią się o 15:36, aby kolejna próba pokazała, co pamiętasz.",
      }),
    ).toBeTruthy();
  });

  test("tells a caught-up learner when their next review falls due, on a Polish date", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      learnerProgress: async () => ({
        modelVersion: "v1",
        objectives: [
          {
            objectiveId: "a",
            title: "Greetings",
            phase: "retaining",
            lastEvidenceAt: "2026-06-01T00:00:00.000Z",
            stability: 3,
            retrievability: 0.95,
            due: false,
            dueAt: "2026-06-05T09:31:00.000Z",
            evidence: [{ outcome: "success", at: "2026-06-01T00:00:00.000Z" }],
          },
        ],
      }),
    });

    const when = new Date("2026-06-05T09:31:00.000Z").toLocaleString("pl", {
      dateStyle: "full",
      timeStyle: "short",
    });
    // 09:31 UTC is 15:01 in the browser's zone.
    expect(when).toMatch(/czerwca 2026.*15:01/);
    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description: `Na razie nic nie czeka na powtórkę. Następna powtórka: „Greetings”, ${when}.`,
      }),
    ).toBeTruthy();
    expect(screen.getByText("1 utrwalony")).toBeTruthy();
    cleanup();

    renderAt("/courses/c1", { signedIn: true });
    expect(
      await screen.findByRole("region", {
        name: "Jesteś na bieżąco",
        description: "Na razie nic nie czeka na powtórkę.",
      }),
    ).toBeTruthy();
  });

  // Polish counts in three forms: one, a few, many.
  test.each([
    [1, "1 nierozpoczęty"],
    [2, "2 nierozpoczęte"],
    [5, "5 nierozpoczętych"],
  ])("counts %i objective(s) not started as %s", async (count, line) => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => activity,
      learnerProgress: async () => notStarted(count),
    });

    fireEvent.click(await screen.findByText(line));
    // Beside a title, in a form that fits any title.
    expect(screen.getByText("Objective 0: nie rozpoczęto")).toBeTruthy();
  });

  test("says when a course has nothing to practise, or is not the learner's", async () => {
    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => ({ decision: activity.decision, objective: activity.objective }),
    });
    expect(
      await screen.findByRole("region", {
        name: "Na razie nie ma nic do ćwiczenia",
        description: "Następny jest temat „Past tense”, ale nie ma jeszcze do niego ćwiczeń.",
      }),
    ).toBeTruthy();
    cleanup();

    renderAt("/courses/c1", {
      signedIn: true,
      nextActivity: async () => {
        throw new BraivoError(404, "not found");
      },
    });
    expect(
      await screen.findByRole("region", {
        name: "Ten kurs nie istnieje albo nie masz do niego dostępu.",
      }),
    ).toBeTruthy();
  });
});
