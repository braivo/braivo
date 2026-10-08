// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale } from "@braivo/i18n";
import { BraivoError, type LearnerProgressReport, type Organization } from "@braivo/server/client";
import {
  createBrowserHistory,
  createMemoryHistory,
  type RouterHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import type { AppContext } from "./lib/context.ts";
import { createConsoleRouter } from "./router.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const members = [
  { userId: "u1", name: "Olive Owner", roles: ["owner"] },
  { userId: "u2", name: "Lee Learner", roles: ["member"] },
];

/** Braivo's overview of `course-1`: every member counted, by name, and every objective. */
const courseProgress = async () => ({
  modelVersion: "v1",
  learners: [
    { ...members[1]!, standings: { unseen: 0, acquiring: 1, retained: 0, due: 1 } },
    { ...members[0]!, standings: { unseen: 2, acquiring: 0, retained: 0, due: 0 } },
  ],
  objectives: [
    {
      objectiveId: "greetings",
      title: "Greetings",
      standings: { unseen: 1, acquiring: 1, retained: 0, due: 0 },
    },
    {
      objectiveId: "numbers",
      title: "Numbers",
      standings: { unseen: 1, acquiring: 0, retained: 0, due: 1 },
    },
  ],
});

const school: Organization = {
  id: "org-1",
  name: "Example School",
  slug: "example",
  learnDomain: "example.braivo.app",
};
const annex: Organization = { id: "org-2", name: "Annex", slug: "annex", learnDomain: null };

/**
 * The console as an owner reaches it, with Braivo and Better Auth stubbed. The
 * route tree is the real one. The owner manages `school` alone unless a test
 * says otherwise.
 */
function renderAt(
  path: string,
  stubs: {
    signedIn?: boolean;
    /** The account's name, once signed in: none for one an emailed code just made. */
    name?: string;
    braivo?: object;
    organizations?: Organization[];
    /** Better Auth's device flow: `device(query)`, with `approve` and `deny` on it. */
    device?: object;
    /** Better Auth's session read, in place of one answering at once. */
    getSession?: () => Promise<unknown>;
    /** The browser's, whose Back a blocker can stop, unlike a memory history's; `path` is then ignored. */
    history?: RouterHistory;
  } = {},
) {
  const account = { name: stubs.name ?? "Olive Owner", email: "olive@example.com" };
  let signedIn = stubs.signedIn ?? true;
  const auth = {
    getSession: async () => ({ data: signedIn ? { user: { ...account } } : null, error: null }),
    emailOtp: { sendVerificationOtp: vi.fn(async () => ({ error: null })) },
    signIn: {
      emailOtp: vi.fn(async () => {
        signedIn = true;
        return { data: { user: { ...account } }, error: null };
      }),
      social: vi.fn(async () => ({ error: null })),
    },
    updateUser: vi.fn(async ({ name }: { name: string }) => {
      account.name = name;
      return { error: null };
    }),
    signOut: vi.fn(async () => {
      signedIn = false;
      return { error: null };
    }),
    device: stubs.device,
    ...(stubs.getSession && { getSession: stubs.getSession }),
  };
  const visit = vi.fn<AppContext["visit"]>();

  const router = createConsoleRouter({
    history: stubs.history ?? createMemoryHistory({ initialEntries: [path] }),
    context: {
      auth: auth as unknown as AppContext["auth"],
      braivo: {
        listOrganizations: async () => stubs.organizations ?? [school],
        listMembers: async () => members,
        courseProgress,
        signInMethods: async () => ({ google: false }),
        ...stubs.braivo,
      } as unknown as AppContext["braivo"],
      visit,
    },
  });
  render(<RouterProvider router={router} />);

  return { auth, router, visit };
}

/**
 * Signs in from `/login` as a person would: an email, then the code mailed to
 * it, whose last digit submits it.
 */
async function signInWithCode() {
  fireEvent.change(await screen.findByLabelText("Email"), {
    target: { value: "owner@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
}

/** A course as authored, one objective taught by a passage and practised by a task. */
const beginners = {
  id: "course-1",
  title: "Beginners",
  objectives: [
    {
      id: "greetings",
      title: "Greetings",
      citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
      tasks: [
        {
          id: "t1",
          kind: "choice" as const,
          prompt: "Hello, in Spanish?",
          options: ["Hola", "Adiós"],
          answer: 0,
          explanation: "Adiós is goodbye.",
          citations: [{ sourceId: "s1", start: 0, end: 5, quote: "Hola." }],
        },
      ],
    },
    { id: "numbers", title: "Numbers", citations: [], tasks: [] },
  ],
  sources: [{ id: "s1", title: "Unidad 1", createdAt: "2026-06-01T00:00:00.000Z" }],
};

/** Braivo's `readCourse`, answering `course-1` and refusing any other as Braivo does. */
async function readCourse({ courseId }: { courseId: string }) {
  if (courseId === beginners.id) return beginners;
  throw new BraivoError(404, "Braivo answered 404.");
}

/** A device-flow stub: `status` for a known code, an error for any other. */
function deviceFlow(status = "pending") {
  const device = Object.assign(
    vi.fn(async ({ query }: { query: { user_code: string } }) =>
      ["ABCD2345", "EFGH6789"].includes(query.user_code)
        ? { data: { user_code: query.user_code, status, client_id: "braivo-cli" }, error: null }
        : {
            data: null,
            error: { status: 400, error: "invalid_request", error_description: "Invalid" },
          },
    ),
    {
      approve: vi.fn(async () => ({ data: { success: true }, error: null })),
      deny: vi.fn(async () => ({ data: { success: true }, error: null })),
    },
  );
  return device;
}

/**
 * A proxy's timeout told as one: that the request may have counted, what to
 * change, and not to try again unchanged.
 */
function expectProxyTimeoutExplained(alert: HTMLElement) {
  expect(alert.textContent).toMatch(/may still use one of this month's AI requests/);
  expect(alert.textContent).toMatch(/Less material may finish sooner/);
  expect(alert.textContent).toMatch(/up to five minutes/);
  expect(alert.textContent).not.toMatch(/Try again/);
}

/** A pending action's button: locked, but never disabled, which would drop the focus. */
function expectLockedInFocus(button: HTMLElement) {
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.matches(":disabled")).toBe(false);
  expect(document.activeElement).toBe(button);
}

describe("the console", () => {
  test.each([
    ["their only organization", [school], "/example"],
    ["the picker, among several", [school, annex], "/organizations"],
    ["the picker, which says there are none", [], "/organizations"],
  ])("sends an owner at / to %s", async (_case, organizations, where) => {
    const { router } = renderAt("/", { organizations, braivo: { listCourses: async () => [] } });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe(where));
  });

  test("returns an owner at / to the organization they last opened, while it is theirs", async () => {
    const organizations = [school, annex];
    const braivo = { listCourses: async () => [] };
    renderAt("/annex", { organizations, braivo });
    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    cleanup();

    const { router } = renderAt("/", { organizations, braivo });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/annex"));
    cleanup();

    // Found by ID, and opened at its current slug.
    const renamed = renderAt("/", {
      organizations: [school, { ...annex, slug: "annex-school" }],
      braivo,
    });
    await vi.waitFor(() => expect(renamed.router.state.location.pathname).toBe("/annex-school"));
    cleanup();

    const left = renderAt("/", { organizations: [school], braivo });
    await vi.waitFor(() => expect(left.router.state.location.pathname).toBe("/example"));
  });

  test("asks an account an emailed code just made for its name, then goes where it was headed", async () => {
    const { auth, router } = renderAt("/example", {
      signedIn: false,
      name: "",
      braivo: { listCourses: async () => [] },
    });

    await signInWithCode();
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
    expect(router.history.location.pathname).toBe("/login");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalledWith({ name: "Olive" });
    expect(router.history.location.pathname).toBe("/example");
  });

  test("lets no account without a name past sign-in, however it arrives", async () => {
    // Signed in, then gone before naming the account: the next visit asks again.
    const { auth, router } = renderAt("/example", {
      name: "",
      braivo: { listCourses: async () => [] },
    });

    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
    expect(router.state.location.search).toEqual({ redirect: "/example" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  test("signs an owner out, saying so when it could not and letting them try again", async () => {
    const { auth, router } = renderAt("/example", { braivo: { listCourses: async () => [] } });
    const refused = Promise.withResolvers<{ error: { status: number } }>();
    auth.signOut.mockReturnValueOnce(refused.promise as never);
    auth.signOut.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    fireEvent.click(signOut);
    // Locked while it is sent, but never disabled, which would drop the focus.
    fireEvent.click(signOut);
    expect(signOut.getAttribute("aria-disabled")).toBe("true");
    expect(signOut.matches(":disabled")).toBe(false);
    expect(auth.signOut).toHaveBeenCalledOnce();
    refused.resolve({ error: { status: 500 } });
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    fireEvent.click(signOut);
    await vi.waitFor(() => expect(auth.signOut).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out. Try again.");
    expect(router.state.location.pathname).toBe("/example");

    fireEvent.click(signOut);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  describe("signing in with Google", () => {
    const withGoogle = { signInMethods: async () => ({ google: true }) };

    test("is offered when the installation has it, and comes back where sign-in was headed", async () => {
      const { auth } = renderAt("/login?redirect=%2Fdevice", {
        signedIn: false,
        braivo: withGoogle,
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

      expect(auth.signIn.social).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/device",
        errorCallbackURL: "/login?redirect=%2Fdevice",
      });
    });

    test("is asked about while the session is read, not after", async () => {
      let answer!: () => void;
      const signInMethods = vi.fn(async () => ({ google: true }));
      renderAt("/login", {
        braivo: { signInMethods },
        getSession: () =>
          new Promise((resolve) => {
            answer = () => resolve({ data: null, error: null });
          }),
      });

      await vi.waitFor(() => expect(signInMethods).toHaveBeenCalled());
      answer();
      expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeTruthy();
    });

    test("is not offered when the installation lacks it, or cannot say", async () => {
      renderAt("/login", { signedIn: false });
      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
      cleanup();

      renderAt("/login", {
        signedIn: false,
        braivo: { signInMethods: () => Promise.reject(new TypeError("Failed to fetch")) },
      });
      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    });

    test("says why it came back refused, and tries again without the old refusal", async () => {
      const { auth } = renderAt("/login?error=email_not_verified&redirect=%2Fdevice", {
        signedIn: false,
        braivo: withGoogle,
      });

      expect(await screen.findByText(/Google account's email is not verified/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
      expect(auth.signIn.social).toHaveBeenCalledWith(
        expect.objectContaining({ errorCallbackURL: "/login?redirect=%2Fdevice" }),
      );
    });

    test("for a learn domain, comes back to its sign-in, which offers the account", async () => {
      const fernwood = { organization: { name: "Fernwood" }, hostname: "learn.fernwood.example" };
      const { auth } = renderAt("/login?handoff=h1", {
        signedIn: false,
        braivo: { ...withGoogle, handoff: async () => fernwood },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

      expect(auth.signIn.social).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/login?handoff=h1",
        errorCallbackURL: "/login?handoff=h1",
      });
    });
  });

  describe("signing in for a learn domain", () => {
    const fernwood = { organization: { name: "Fernwood" }, hostname: "learn.fernwood.example" };
    const url = "https://learn.fernwood.example/api/session/handoff?code=c1";

    test("names the organization and its domain, not Braivo, and hands the account over", async () => {
      const completeHandoff = vi.fn(async () => url);
      const { visit } = renderAt("/login?handoff=h1", {
        signedIn: false,
        braivo: { handoff: async () => fernwood, completeHandoff },
      });

      const heading = await screen.findByRole("heading", { name: "Sign in to Fernwood" });
      // Without the console's colours (`__root.tsx`).
      expect(heading.closest("[data-learn-domain]")).toBeTruthy();
      expect(screen.getByText(/learn\.fernwood\.example/)).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Sign in to Fernwood"));
      expect(screen.queryByText(/Braivo/)).toBeNull();
      await signInWithCode();

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
      expect(completeHandoff).toHaveBeenCalledWith("h1");
    });

    test("offers the account already signed in, or another", async () => {
      const completeHandoff = vi.fn(async () => url);
      const { auth, visit } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood, completeHandoff },
      });

      const offered = await screen.findByRole("button", { name: "Continue as Olive Owner" });
      // Offered, not used: nothing is handed over until it is chosen.
      expect(completeHandoff).not.toHaveBeenCalled();
      expect(visit).not.toHaveBeenCalled();
      fireEvent.click(offered);
      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
      expect(completeHandoff).toHaveBeenCalledOnce();
      expect(auth.signOut).not.toHaveBeenCalled();
      cleanup();

      const other = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood, completeHandoff: async () => url },
      });
      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));
      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(other.auth.signOut).toHaveBeenCalledOnce();
    });

    test("switches account once without natively disabling either button", async () => {
      const completeHandoff = vi.fn(async () => url);
      const { auth } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood, completeHandoff },
      });
      const signedOut = Promise.withResolvers<{ error: null }>();
      auth.signOut.mockReturnValueOnce(signedOut.promise);

      const another = await screen.findByRole("button", { name: "Use another account" });
      const offered = screen.getByRole("button", { name: "Continue as Olive Owner" });
      fireEvent.click(another);
      fireEvent.click(another);
      fireEvent.click(offered);

      expect(auth.signOut).toHaveBeenCalledOnce();
      expect(completeHandoff).not.toHaveBeenCalled();
      for (const button of [another, offered]) {
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.matches(":disabled")).toBe(false);
      }
      signedOut.resolve({ error: null });
      expect(await screen.findByLabelText("Email")).toBeTruthy();
    });

    test("says when the account is not a member, offering another, or to retry once added", async () => {
      let member = false;
      let email = "olive@example.com";
      const { visit } = renderAt("/login?handoff=h1", {
        getSession: async () => ({ data: { user: { name: "Olive Owner", email } }, error: null }),
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            if (!member) throw new BraivoError(403, "Braivo answered 403.");
            return url;
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      // By the email the school adds members with.
      expect((await screen.findByRole("alert")).textContent).toBe(
        "olive@example.com is not a member of Fernwood. Ask to be added with this email, then try again.",
      );
      expect(screen.getByRole("button", { name: "Use another account" })).toBeTruthy();
      // The pressed button is gone; the focus goes to what comes next.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));

      // Too soon: refused again, naming the session read after it, the focus
      // back on Try again.
      email = "lee@example.com";
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByText(
          "lee@example.com is not a member of Fernwood. Ask to be added with this email, then try again.",
        ),
      ).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));

      // The operator adds them meanwhile.
      member = true;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
    });

    // Better Auth answers a failed read with an error, or throws when unreachable.
    test.each([
      ["answered with an error", async () => ({ data: null, error: { status: 500 } })],
      [
        "unreachable",
        async () => {
          throw new TypeError("Failed to fetch");
        },
      ],
    ])("still says an account is not a member when the session read is %s", async (_, unread) => {
      let reads = 0;
      renderAt("/login?handoff=h1", {
        // Read once as the page opens, then failing at the refusal.
        getSession: async () =>
          reads++ > 0
            ? unread()
            : { data: { user: { name: "Olive Owner", email: "olive@example.com" } }, error: null },
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(403, "Braivo answered 403.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(
        await screen.findByText(
          "This account is not a member of Fernwood. Ask to be added, then try again.",
        ),
      ).toBeTruthy();
    });

    test("asks the next account for its email, after one that had no name", async () => {
      renderAt("/login?handoff=h1", {
        name: "",
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(403, "Braivo answered 403.");
          },
        },
      });

      // Offered by email, so another person can switch rather than name it.
      fireEvent.click(await screen.findByRole("button", { name: "Continue as olive@example.com" }));
      fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Olive" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));

      expect(await screen.findByLabelText("Email")).toBeTruthy();
    });

    test("lets another person switch from an account left without a name, naming nothing", async () => {
      const { auth } = renderAt("/login?handoff=h1", {
        name: "",
        braivo: { handoff: async () => fernwood, completeHandoff: async () => url },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));

      expect(await screen.findByLabelText("Email")).toBeTruthy();
      expect(auth.updateUser).not.toHaveBeenCalled();
    });

    test("asks to sign in again when the session ended meanwhile", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(401, "Braivo answered 401.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(await screen.findByText("You were signed out. Sign in again.")).toBeTruthy();
      expect(screen.getByLabelText("Email")).toBeTruthy();
    });

    test("leads back to the domain from expiry reached while signing in", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(404, "Braivo answered 404.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      // Focused, as the button pressed is gone.
      const heading = await screen.findByRole("heading", { name: "This sign-in has expired" });
      expect(document.activeElement).toBe(heading);
      expect(document.title).toBe("This sign-in has expired");
      // The domain is known by then: a new sign-in is one click away.
      expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
        "https://learn.fernwood.example/login",
      );
    });

    test("speaks the browser's language, under the organization's name", async () => {
      onTestFinished(() => activateLocale("en"));
      await activateLocale(chooseLocale(["pl-PL", "en"]));
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(403, "Braivo answered 403.");
          },
        },
      });

      expect(await screen.findByRole("heading", { name: "Logowanie: Fernwood" })).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("Logowanie: Fernwood"));
      expect(screen.getByText("Potem przejdziesz na stronę learn.fernwood.example.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Użyj innego konta" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Kontynuuj jako Olive Owner" }));
      expect(
        await screen.findByText(
          "Konto olive@example.com nie należy do organizacji „Fernwood”. Poproś o dodanie tego adresu e-mail, a potem spróbuj ponownie.",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
      cleanup();

      renderAt("/login?handoff=h2", { braivo: { handoff: async () => null } });
      expect(await screen.findByRole("heading", { name: "To logowanie wygasło" })).toBeTruthy();
      expect(screen.getByText("Wróć do poprzedniej strony i zaloguj się ponownie.")).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("To logowanie wygasło"));
      cleanup();

      renderAt("/login?handoff=h3", {
        braivo: {
          handoff: async () => {
            throw new BraivoError(500, "Braivo answered 500.");
          },
        },
      });
      expect(await screen.findByRole("region", { name: "Coś poszło nie tak." })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Spróbuj ponownie" })).toBeTruthy();
      cleanup();

      // The console's own sign-in, still loading after a second, then shown.
      const methods = Promise.withResolvers<{ google: boolean }>();
      renderAt("/login", { signedIn: false, braivo: { signInMethods: () => methods.promise } });
      expect(
        await screen.findByRole("status", { name: "Ładowanie" }, { timeout: 2000 }),
      ).toBeTruthy();
      methods.resolve({ google: false });
      expect(await screen.findByLabelText("E-mail")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Wyślij kod" })).toBeTruthy();
    });

    test("names no account it did not read, when continuing must be tried again", async () => {
      const completeHandoff = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(url);
      const { visit } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood, completeHandoff },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));
      await signInWithCode();
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
    });

    test("tells a server's failure from a lost connection, offering to continue again", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => fernwood,
          completeHandoff: async () => {
            throw new BraivoError(500, "Braivo answered 500.");
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue as Olive Owner" }));

      expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Continue as Olive Owner" })).toBeTruthy();
    });

    test("says when it has expired", async () => {
      renderAt("/login?handoff=gone", { braivo: { handoff: async () => undefined } });

      const heading = await screen.findByRole("heading", { name: "This sign-in has expired" });
      // Nothing was focused to move from.
      expect(document.activeElement).not.toBe(heading);
      expect(screen.queryByLabelText("Email")).toBeNull();
      // Nothing says where it came from.
      expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
      // Not Braivo's name or colours, on the way back to an organization's site.
      expect(heading.closest("[data-learn-domain]")).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("This sign-in has expired"));
    });

    test("keeps Braivo's colours off when it fails to load, unlike the console's own sign-in", async () => {
      renderAt("/login?handoff=h1", {
        braivo: {
          handoff: async () => {
            throw new Error("down");
          },
        },
      });
      const failure = await screen.findByRole("region", { name: "Something went wrong." });
      expect(failure.closest("[data-learn-domain]")).toBeTruthy();
      cleanup();

      renderAt("/login", { signedIn: false });
      const heading = await screen.findByRole("heading", { name: "Braivo Console" });
      expect(heading.closest("[data-learn-domain]")).toBeNull();
    });
  });

  test("lets an owner approve their own tool, naming it and the code", async () => {
    const device = deviceFlow();
    renderAt("/device?user_code=ABCD2345", { device });

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.getByText(/Braivo's command-line tool/)).toBeTruthy();
    expect(screen.getByText("ABCD2345")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
    expect(device.approve).toHaveBeenCalledWith({ userCode: "ABCD2345" });
    expect(device.deny).not.toHaveBeenCalled();
  });

  test("sends one decision at a time", async () => {
    const device = deviceFlow();
    let answer!: () => void;
    device.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ data: { success: true }, error: null });
        }),
    );
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const deny = screen.getByRole("button", { name: "Deny" });
    fireEvent.click(deny);
    expect(deny.getAttribute("aria-disabled")).toBe("true");
    expect(deny.matches(":disabled")).toBe(false);
    answer();

    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
    expect(device.deny).not.toHaveBeenCalled();
  });

  test("lets an owner decide again when the answer could not be sent", async () => {
    const device = deviceFlow();
    device.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/could not record your answer/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Signed in. You can go back to your terminal.")).toBeTruthy();
  });

  test("lets an owner deny a code they did not start", async () => {
    const device = deviceFlow();
    renderAt("/device?user_code=ABCD2345", { device });

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Denied. Nothing was signed in.")).toBeTruthy();
    expect(device.approve).not.toHaveBeenCalled();
  });

  test("asks for the code when the link was not followed, and says when it is wrong", async () => {
    const device = deviceFlow();
    renderAt("/device", { device });

    fireEvent.change(await screen.findByLabelText("Code shown in your terminal"), {
      target: { value: "WRONG999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/not valid, or has expired/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("never shows one code's decision on another, even one answered late", async () => {
    const device = deviceFlow();
    let answer!: () => void;
    device.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ data: { success: true }, error: null });
        }),
    );
    const { router } = renderAt("/device?user_code=ABCD2345", { device });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    // Back in history, or a second terminal's link: another code, still pending.
    await router.navigate({ to: "/device", search: { user_code: "EFGH6789" } });
    expect(await screen.findByText("EFGH6789")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.getAttribute("aria-disabled")).toBe("false");
    // The first code's approval answers now, and must not land on this one.
    await act(async () => answer());

    expect(screen.getByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.queryByText(/Signed in/)).toBeNull();
  });

  test("leaves one code's failed answer off another", async () => {
    const device = deviceFlow();
    device.approve.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { router } = renderAt("/device?user_code=ABCD2345", { device });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(/could not record your answer/);

    await router.navigate({ to: "/device", search: { user_code: "EFGH6789" } });

    expect(await screen.findByText("EFGH6789")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("says each wrong code typed in is wrong, once Braivo has refused it", async () => {
    const device = deviceFlow();
    renderAt("/device", { device });
    const input = (await screen.findByLabelText("Code shown in your terminal")) as HTMLInputElement;
    const continueButton = screen.getByRole("button", { name: "Continue" });

    let previous: HTMLElement | null = null;
    for (const code of ["WRONG111", "WRONG222", "WRONG333"]) {
      let answer!: () => void;
      device.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () =>
              resolve({
                data: null,
                error: { status: 400, error: "invalid_request", error_description: "Invalid" },
              });
          }),
      );
      fireEvent.change(input, { target: { value: code } });
      fireEvent.click(continueButton);
      await vi.waitFor(() =>
        expect(device).toHaveBeenLastCalledWith({ query: { user_code: code } }),
      );
      // Nothing is said about a code before Braivo answers.
      expect(screen.queryByRole("alert")).toBe(previous);
      answer();

      // A new alert each time, so it can be announced again; an unchanged one gives no new alert.
      const alert = await vi.waitFor(() => {
        const current = screen.getByRole("alert");
        expect(current).not.toBe(previous);
        return current;
      });
      expect(alert.textContent).toMatch(/not valid, or has expired/);
      previous = alert;
    }
  });

  test("refuses a code of only spaces without navigating", async () => {
    // Already at a refused code, so leaving it would show.
    const { router } = renderAt("/device?user_code=WRONG999", { device: deviceFlow() });
    const input = (await screen.findByLabelText("Code shown in your terminal")) as HTMLInputElement;
    await screen.findByRole("alert");

    // Set without an input event, as a browser restoring the form would.
    input.value = "   ";
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(input.validationMessage).toBe("Enter the code.");
    expect(router.history.location.search).toBe("?user_code=WRONG999");
    expect(screen.getByRole("alert").textContent).toMatch(/not valid/);
    fireEvent.change(input, { target: { value: " ABCD2345 " } });
    expect(input.validationMessage).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
  });

  test("lets an owner try again when the code could not be looked up", async () => {
    const device = deviceFlow();
    device.mockResolvedValueOnce({
      data: null,
      error: { status: 500, error: "server_error", error_description: "" },
    });
    renderAt("/device?user_code=ABCD2345", { device });

    // Not "not valid": nothing was said about the code, which may still be good.
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(screen.queryByText(/not valid/)).toBeNull();
  });

  test("offers nothing to approve for a code already answered", async () => {
    renderAt("/device?user_code=ABCD2345", { device: deviceFlow("approved") });

    expect(await screen.findByText("This code was already approved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  test("returns a signed-out owner to the code they followed once they sign in", async () => {
    const { router } = renderAt("/device?user_code=ABCD2345", {
      signedIn: false,
      device: deviceFlow(),
    });

    await signInWithCode();

    expect(await screen.findByText("Let a tool act as you?")).toBeTruthy();
    expect(router.history.location.search).toBe("?user_code=ABCD2345");
  });

  test("returns an owner to the page they asked for once they sign in", async () => {
    const { auth, router } = renderAt("/example", {
      signedIn: false,
      braivo: { listCourses: async () => [] },
    });

    await screen.findByLabelText("Email");
    expect(router.history.location.pathname).toBe("/login");
    await signInWithCode();

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      type: "sign-in",
    });
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      otp: "123456",
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(router.history.location.pathname).toBe("/example");
  });

  test("leads from an organization to its sources", async () => {
    renderAt("/example", { braivo: { listCourses: async () => [] } });

    expect((await screen.findByRole("link", { name: "Sources" })).getAttribute("href")).toBe(
      "/example/sources",
    );
    // With no course yet, the empty list offers them too.
    expect(screen.getByRole("link", { name: "Open Sources" }).getAttribute("href")).toBe(
      "/example/sources",
    );
  });

  test("keeps the Sources link but offers no button once an organization has a course", async () => {
    renderAt("/example", {
      braivo: { listCourses: async () => [{ id: "c1", title: "Spanish" }] },
    });

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sources" }).getAttribute("href")).toBe(
      "/example/sources",
    );
    expect(screen.queryByRole("link", { name: "Open Sources" })).toBeNull();
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
    expect(screen.getByRole("status").textContent).toBe("Address copied.");

    // Refused, as outside a secure context or without permission.
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    const refused = await screen.findByRole("alert");
    expect(refused.textContent).toBe("Could not copy. Select the address instead.");
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

  test("lists an organization's material, saying what each keeps", async () => {
    renderAt("/example/sources", {
      braivo: {
        listSources: async () => [
          {
            id: "s1",
            title: "Los animales",
            url: "https://www.youtube.com/watch?v=animales",
            language: "es",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          { id: "s2", title: "Mi libro", original: "f".repeat(64), createdAt: "…" },
        ],
      },
    });

    const video = await screen.findByRole("link", { name: "Los animales" });
    expect(video.getAttribute("href")).toBe("/example/sources/s1");
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first!).getByText("es")).toBeTruthy();
    expect(within(second!).getByText("Original kept")).toBeTruthy();
  });

  /** Fills the add form; `file` goes in as the original. */
  function addMaterial(fields: {
    title: string;
    text: string;
    url?: string;
    language?: string;
    file?: File;
  }) {
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: fields.title } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: fields.text } });
    if (fields.url) {
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: fields.url } });
    }
    if (fields.language) {
      fireEvent.change(screen.getByLabelText("Language"), { target: { value: fields.language } });
    }
    if (fields.file) {
      fireEvent.change(screen.getByLabelText("Original file"), {
        target: { files: [fields.file] },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));
  }

  /** Braivo's source reads, answering the one source added. */
  const added = {
    listSources: async () => [],
    getSource: async () => ({ id: "s1", title: "Unidad 1", text: "Hola.", createdAt: "…" }),
  };

  test("adds pasted text as a source with its link and language, and opens it", async () => {
    const addSource = vi.fn(async () => "s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Unidad 1",
      text: "Hola.",
      url: "https://example.com/unidad-1",
      language: "es",
    });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(addSource).toHaveBeenCalledWith({
      organizationId: "org-1",
      title: "Unidad 1",
      text: "Hola.",
      url: "https://example.com/unidad-1",
      language: "es",
      original: undefined,
    });
  });

  test("titles material from its file's name, never over a title typed", async () => {
    renderAt("/example/sources", { braivo: { listSources: async () => [] } });
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const attach = (name: string) =>
      fireEvent.change(screen.getByLabelText("Original file"), {
        target: { files: [new File(["%PDF"], name, { type: "application/pdf" })] },
      });

    attach("Unidad_1_Saludos.pdf");
    expect(title.value).toBe("Unidad 1 Saludos");
    // Another file, the title untouched: replaced.
    attach("Unidad_2.final.pdf");
    expect(title.value).toBe("Unidad 2.final");
    // Typed, even to the same value: the person's now, kept.
    fireEvent.input(title, { target: { value: "Unidad 2.final" } });
    attach("Unidad_3.pdf");
    expect(title.value).toBe("Unidad 2.final");
    fireEvent.input(title, { target: { value: "Greetings" } });
    attach("Unidad_4.pdf");
    expect(title.value).toBe("Greetings");
  });

  test("suggests languages by name, as the tag Braivo stores", async () => {
    renderAt("/example/sources", { braivo: { listSources: async () => [] } });

    const language = await screen.findByLabelText("Language");
    const list = document.getElementById(language.getAttribute("list")!)!;
    expect(list.querySelector('option[value="es"]')?.textContent).toBe("Spanish");
    expect(list.querySelector('option[value="pl"]')?.textContent).toBe("Polish");
  });

  test("sends a language named in full as its tag, and any other as typed", async () => {
    const addSource = vi.fn(async (_source: { language?: string }) => "s1");
    const sent = async (language: string) => {
      const { router } = renderAt("/example/sources", { braivo: { ...added, addSource } });
      await screen.findByText("No material yet");
      addMaterial({ title: "Unidad 1", text: "Hola.", language });
      await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
      cleanup();
      return addSource.mock.lastCall?.[0].language;
    };

    // Where a browser shows tags alone (iOS Safari), the name typed in full.
    expect(await sent(" sPaNiSh ")).toBe("es");
    expect(await sent("Polish")).toBe("pl");
    // Any language with a two-letter tag, not only those suggested.
    expect(await sent("Czech")).toBe("cs");
    // A name two tags share, one deprecated: the current one.
    expect(await sent("Romanian")).toBe("ro");
    // `ak`, never `tw`, which some engines also name Akan.
    expect(await sent("Akan")).toBe("ak");
    expect(await sent("es-MX")).toBe("es-MX");
    // Not one it knows: Braivo's refusal says why.
    expect(await sent("Klingon")).toBe("Klingon");
  });

  test("holds the form still while it is sent, the focus kept where it was", async () => {
    const adding = Promise.withResolvers<string>();
    const addSource = vi.fn(() => adding.promise);
    renderAt("/example/sources", {
      braivo: { ...added, addSource },
    });
    await screen.findByText("No material yet");
    const button = screen.getByRole("button", { name: "Add material" });
    button.focus();

    addMaterial({ title: "Unidad 1", text: "Hola." });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expectLockedInFocus(button);
    // Enter in a field submits however the button is marked.
    fireEvent.submit(button.closest("form")!);
    // Nothing typed meanwhile, which would not be what was added.
    for (const label of ["Title", "Text", "Link", "Language"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
    }
    expect((screen.getByLabelText("Original file") as HTMLInputElement).disabled).toBe(true);
    // A disabled fieldset would disable the button too; the test DOM does not apply it.
    expect(button.closest("fieldset")?.disabled).toBe(false);
    expect(addSource).toHaveBeenCalledTimes(1);
    adding.resolve("s1");
    expect(await screen.findByRole("heading", { name: "Unidad 1" })).toBeTruthy();
  });

  test("leaves an owner where they went when the source they left is added", async () => {
    const adding = Promise.withResolvers<string>();
    const addSource = vi.fn(() => adding.promise);
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        // Annex's sources still loading when the source is added.
        listSources: (organizationId: string) =>
          organizationId === "org-1" ? Promise.resolve([]) : new Promise(() => {}),
        addSource,
      },
      organizations: [school, annex],
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    void router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "annex" },
    });
    adding.resolve("s1");
    await adding.promise;

    expect(router.history.location.pathname).toBe("/annex/sources");
  });

  test("leaves an owner on the page they returned to when the source they left is added", async () => {
    const adding = Promise.withResolvers<string>();
    const addSource = vi.fn(() => adding.promise);
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, addSource, listCourses: async () => [] },
    });
    await screen.findByText("No material yet");

    addMaterial({ title: "Unidad 1", text: "Hola." });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    await router.navigate({ to: "/$organizationSlug", params: { organizationSlug: "example" } });
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "example" },
    });
    adding.resolve("s1");
    await adding.promise;

    expect(router.history.location.pathname).toBe("/example/sources");
  });

  test("stops uploading and reading a file nobody is waiting for once the owner leaves", async () => {
    let signal: AbortSignal | undefined;
    let uploading: AbortSignal | undefined;
    const readFileText = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>(() => {});
    });
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          uploading = options?.signal;
          return { fileId: "f".repeat(64) };
        },
        readFileText,
        addSource: async () => "s1",
      },
      organizations: [school, annex],
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    // The same page, another organization's.
    await router.navigate({
      to: "/$organizationSlug/sources",
      params: { organizationSlug: "annex" },
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(uploading).toBe(signal);
  });

  test("has Braivo's AI read an attached file when no text is pasted", async () => {
    const pages = [{ page: "12", text: "Hola significa hello." }];
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const readFileText = vi.fn(async () => pages);
    const addSource = vi.fn(async () => "s1");
    const { router } = renderAt("/example/sources", {
      braivo: { ...added, uploadFile, readFileText, addSource },
    });
    await screen.findByText("No material yet");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(readFileText).toHaveBeenCalledWith(
      { organizationId: "org-1", fileId: "f".repeat(64) },
      { signal: expect.any(AbortSignal) },
    );
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Mi libro", pages, original: "f".repeat(64) }),
    );
  });

  test("says which step is under way while material is added", async () => {
    const uploading = Promise.withResolvers<{ fileId: string }>();
    const reading = Promise.withResolvers<{ page: string; text: string }[]>();
    const adding = Promise.withResolvers<string>();
    renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: () => uploading.promise,
        readFileText: () => reading.promise,
        addSource: () => adding.promise,
      },
    });
    await screen.findByText("No material yet");
    // Present from the start, so what it says next is announced.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Adding the same material again adds nothing.");

    addMaterial({
      title: "Mi libro",
      text: "",
      file: new File(["%PDF"], "libro.pdf", { type: "application/pdf" }),
    });
    await vi.waitFor(() => expect(status.textContent).toBe("Uploading the file…"));
    uploading.resolve({ fileId: "f".repeat(64) });
    await vi.waitFor(() => expect(status.textContent).toMatch(/reading the file.*a few minutes/));
    reading.resolve([{ page: "1", text: "Hola." }]);
    await vi.waitFor(() => expect(status.textContent).toBe("Adding…"));
    adding.resolve("s1");
    expect(await screen.findByRole("heading", { name: "Unidad 1" })).toBeTruthy();
  });

  test("says a proxy cut off reading a file, and not an upload", async () => {
    const cutOff = new BraivoError(504, "Braivo answered 504 reading a file's text.");
    const uploadFile = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(504, "Braivo answered 504 uploading a file."))
      .mockResolvedValue({ fileId: "f".repeat(64) });
    renderAt("/example/sources", {
      braivo: { ...added, uploadFile, readFileText: vi.fn().mockRejectedValue(cutOff) },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "", file: pdf });
    expect(await screen.findByText("The material could not be added. Try again.")).toBeTruthy();
    addMaterial({ title: "Mi libro", text: "", file: pdf });

    expectProxyTimeoutExplained(await screen.findByText(/timed out/));
  });

  test("reads a file once, however often adding its pages is refused", async () => {
    const readFileText = vi.fn(async () => [{ page: "1", text: "Hola." }]);
    const addSource = vi
      .fn()
      .mockRejectedValueOnce(
        new BraivoError(400, "Braivo answered 400.", "The source's language must be a BCP 47 tag."),
      )
      .mockResolvedValueOnce("s1");
    const { router } = renderAt("/example/sources", {
      braivo: {
        ...added,
        uploadFile: async () => ({ fileId: "f".repeat(64) }),
        readFileText,
        addSource,
      },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "", language: "en_US", file: pdf });
    expect(await screen.findByText("The source's language must be a BCP 47 tag.")).toBeTruthy();
    addMaterial({ title: "Mi libro", text: "", language: "en-US", file: pdf });

    await vi.waitFor(() => expect(router.history.location.pathname).toBe("/example/sources/s1"));
    expect(readFileText).toHaveBeenCalledTimes(1);
  });

  test("asks for text or a file, having neither", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Nada", text: "  " });

    expect(
      await screen.findByText(
        "Paste the material's text, or attach the file for Braivo's AI to read.",
      ),
    ).toBeTruthy();
    expect(addSource).not.toHaveBeenCalled();
  });

  test("uploads the original first, and adds the source naming it, leaving out what was left blank", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", {
      braivo: { listSources: async () => [], uploadFile, addSource },
    });
    await screen.findByText("No material yet");
    const pdf = new File(["%PDF-1.7"], "libro.pdf", { type: "application/pdf" });

    addMaterial({ title: "Mi libro", text: "Hola.", url: " ", language: " ", file: pdf });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith(
      { organizationId: "org-1", file: pdf },
      { signal: expect.any(AbortSignal) },
    );
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({ url: undefined, language: undefined, original: "f".repeat(64) }),
    );
  });

  test("says what Braivo refused, and what it could not send", async () => {
    const addSource = vi.fn();
    renderAt("/example/sources", {
      braivo: {
        listSources: async () => [],
        uploadFile: async () => {
          throw new BraivoError(
            501,
            "Braivo answered 501.",
            "This Braivo installation stores no files.",
          );
        },
        addSource,
      },
    });
    await screen.findByText("No material yet");

    const pdf = new File(["%PDF"], "libro.pdf", { type: "application/pdf" });
    addMaterial({ title: "Mi libro", text: "Hola.", file: pdf });
    expect(await screen.findByText("This Braivo installation stores no files.")).toBeTruthy();

    for (const file of [
      new File(["?"], "libro"),
      new File(["Hola."], "libro.txt", { type: "text/plain" }),
    ]) {
      addMaterial({ title: "Mi libro", text: "Hola.", file });
      expect(
        await screen.findByText(
          "The original file must be a PDF, a document, or an image; plain text goes in the Text field.",
        ),
      ).toBeTruthy();
    }
    expect(addSource).not.toHaveBeenCalled();
  });

  /** A file of `type` claiming `size` bytes, so none are allocated. */
  const fileOf = (type: string, size: number) =>
    Object.defineProperty(new File(["?"], "libro", { type }), "size", { value: size });

  test("refuses a file over 50 MB before sending anything, and takes exactly 50 MB", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", { braivo: { ...added, uploadFile, addSource } });
    await screen.findByText("No material yet");
    const pdfOf = (size: number) => fileOf("application/pdf", size);

    addMaterial({ title: "Mi libro", text: "Hola.", file: pdfOf(50_000_001) });
    expect(await screen.findByText("The original file is larger than 50 MB.")).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(addSource).not.toHaveBeenCalled();

    addMaterial({ title: "Mi libro", text: "Hola.", file: pdfOf(50_000_000) });
    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  const slides = fileOf("application/vnd.oasis.opendocument.presentation", 4);

  test("refuses a file Braivo's AI cannot read before uploading it, saying what to do instead", async () => {
    const uploadFile = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, uploadFile } });
    await screen.findByText("No material yet");

    for (const [file, refusal] of [
      [
        slides,
        "Braivo's AI reads PDFs and PNG, JPEG, GIF, or WebP images. Paste this file's text or transcript in the Text field to keep the file as its original.",
      ],
      [
        fileOf("application/pdf", 24_000_001),
        "Braivo's AI reads a PDF of at most 24 MB: split it, adding a chapter at a time, or paste its text in the Text field.",
      ],
      [
        fileOf("image/jpeg", 7_500_001),
        "Braivo's AI reads an image of at most 7.5 MB: save it smaller, or paste its text in the Text field.",
      ],
    ] as const) {
      addMaterial({ title: "Mi libro", text: "", file });
      await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(refusal));
    }
    expect(uploadFile).not.toHaveBeenCalled();
  });

  test.each([
    ["a file it cannot read, its text pasted, unread", "Hola.", slides, false],
    [
      "a PDF over 24 MB, its text pasted, unread",
      "Hola.",
      fileOf("application/pdf", 24_000_001),
      false,
    ],
    ["a PDF of exactly 24 MB, and has it read", "", fileOf("application/pdf", 24_000_000), true],
  ])("uploads %s", async (_label, text, file, read) => {
    const uploadFile = vi.fn(async () => ({ fileId: "f".repeat(64) }));
    const readFileText = vi.fn(async () => [{ page: "1", text: "Leído." }]);
    const addSource = vi.fn(async () => "s1");
    renderAt("/example/sources", { braivo: { ...added, uploadFile, readFileText, addSource } });
    await screen.findByText("No material yet");

    addMaterial({ title: "Mi libro", text, file });

    await vi.waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(uploadFile).toHaveBeenCalledWith({ organizationId: "org-1", file }, expect.anything());
    expect(readFileText).toHaveBeenCalledTimes(read ? 1 : 0);
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining(
        read
          ? { pages: [{ page: "1", text: "Leído." }], original: "f".repeat(64) }
          : { text, original: "f".repeat(64) },
      ),
    );
  });

  test("refuses a blank title before uploading or reading anything", async () => {
    const uploadFile = vi.fn();
    renderAt("/example/sources", { braivo: { ...added, uploadFile } });
    await screen.findByText("No material yet");

    // Choosing the file titles the material from its name; then it is cleared.
    fireEvent.change(screen.getByLabelText("Original file"), {
      target: { files: [new File(["%PDF"], "libro.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add material" }));

    expect(await screen.findByText("Give the material a title.")).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  const saludos = {
    id: "s1",
    title: "Saludos",
    text: "Hola significa hello.",
    language: "es",
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  const hello = { sourceId: "s1", quote: "Hola significa hello." };

  /** A draft of two objectives, the first with two tasks, and one thing left out. */
  const drafted = {
    objectives: [
      {
        key: "d1",
        title: "Say hello",
        citations: [hello],
        tasks: [
          {
            kind: "choice",
            prompt: "Hello?",
            options: ["Hola", "Adiós"],
            answer: 0,
            citations: [hello],
          },
          {
            kind: "choice",
            prompt: "Hi?",
            options: ["Hola", "Gracias"],
            answer: 0,
            citations: [hello],
          },
        ],
      },
      {
        key: "d2",
        title: "Say goodbye",
        citations: [hello],
        tasks: [
          {
            kind: "choice",
            prompt: "Bye?",
            options: ["Adiós", "Hola"],
            answer: 0,
            citations: [hello],
          },
        ],
      },
    ],
    refused: [
      "Objective “Greetings”, task “¿Adiós?”: the quote “Adiós.” does not occur in the source.",
    ],
  };

  function authoring() {
    return {
      getSource: async () => saludos,
      draftCourse: vi.fn(async () => drafted),
      acceptDraft: vi.fn(async (): Promise<string> => "course-1"),
      readCourse,
    };
  }

  const LEAVE_REVIEW =
    "Leave this page? The draft and your changes to it will be lost, and drafting again uses another of this month's AI requests.";
  const LEAVE_UNFINISHED =
    "Leave this page? Some or all of this course may already be saved: leaving does not undo it, and may leave it unfinished.";

  /** The owner's answer when leaving a draft under review asks first; Happy DOM has no `confirm`. */
  function answerLeaving(leave: boolean) {
    const confirm = vi.fn((_message?: string) => leave);
    vi.stubGlobal("confirm", confirm);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    return confirm;
  }

  test("links each source to its own page", async () => {
    renderAt("/example/sources", {
      braivo: { listSources: async () => [saludos] },
    });

    expect((await screen.findByRole("link", { name: "Saludos" })).getAttribute("href")).toBe(
      "/example/sources/s1",
    );
  });

  test("offers where a source is from, and the original it was extracted from", async () => {
    const url = "https://example.com/saludos";
    renderAt("/example/sources/s1", {
      braivo: { ...authoring(), getSource: async () => ({ ...saludos, url, original: "ab12" }) },
    });

    const original = await screen.findByRole("link", { name: "Download the original" });
    expect(original.getAttribute("href")).toBe("/api/organizations/org-1/files/ab12");
    expect(screen.getByRole("link", { name: "Where it is from" }).getAttribute("href")).toBe(url);
  });

  test("shows a source's first 20,000 characters, and all of a longer one on request", async () => {
    const shown = "a".repeat(19_999) + "b";
    const view = (text: string) =>
      renderAt("/example/sources/s1", {
        braivo: { ...authoring(), getSource: async () => ({ ...saludos, text }) },
      });

    view(shown);
    // Reachable by Tab, so the keyboard can scroll it, and named for whoever arrives there.
    const box = await screen.findByRole("region", { name: "Source text" });
    expect(box.textContent).toBe(shown);
    expect(box.tabIndex).toBe(0);
    expect(screen.queryByText(/^The first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all text" })).toBeNull();
    cleanup();

    view(`${shown}c`);
    expect(await screen.findByText(shown)).toBeTruthy();
    // Compared raw: a locale's grouping space, such as fr-FR's, is no plain space.
    expect(screen.getByText(/^The first/).textContent).toBe(
      `The first ${(20_000).toLocaleString()} of ${(20_001).toLocaleString()} characters.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all text" }));
    const text = screen.getByRole("region", { name: "Source text" });
    expect(text.textContent).toBe(`${shown}c`);
    // The button is gone, so the text it revealed takes the focus.
    expect(document.activeElement).toBe(text);
    expect(screen.queryByText(/^The first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all text" })).toBeNull();
  });

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
    const site = await screen.findByRole("link", { name: "example.braivo.app" });
    expect(site.parentElement?.textContent).toBe(
      "Open to every learner in Example School at example.braivo.app.",
    );
    // What was kept, and only that.
    expect(braivo.acceptDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      sourceId: "s1",
      title: "Saludos",
      objectives: [{ ...drafted.objectives[0], tasks: [drafted.objectives[0]!.tasks[0]] }],
    });
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
    // Checked like the course's title, before anything is locked in, with
    // focus taken to it from the button at the bottom.
    expect(await screen.findByText("Give objective 1 a title.")).toBeTruthy();
    expect(document.activeElement).toBe(title);
    expect(screen.getByRole("article", { name: "Objective 1" })).toBeTruthy();
    expect(braivo.acceptDraft).not.toHaveBeenCalled();

    // The first to fix in page order, even with the course title also blank.
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "" } });
    screen.getByRole("button", { name: "Create course" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Saludos" } });

    fireEvent.change(title, { target: { value: " Greet someone " } });
    expect(screen.getByRole("article", { name: "Objective 1: Greet someone" })).toBeTruthy();
    // A dropped objective's title is not sent, so it is not checked either.
    fireEvent.change(screen.getByRole("textbox", { name: "Objective 2" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    await vi.waitFor(() => expect(braivo.acceptDraft).toHaveBeenCalled());
    expect(braivo.acceptDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      sourceId: "s1",
      title: "Saludos",
      objectives: [{ ...drafted.objectives[0], title: "Greet someone" }],
    });
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
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    expect(braivo.acceptDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep objective 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));
    await vi.waitFor(() =>
      expect(braivo.acceptDraft).toHaveBeenCalledWith(
        expect.objectContaining({ objectives: [drafted.objectives[0]] }),
      ),
    );
  });

  test("says why a course could not be drafted, or created", async () => {
    const braivo = {
      ...authoring(),
      draftCourse: vi.fn(async (): Promise<typeof drafted> => {
        throw new BraivoError(
          403,
          "Braivo answered 403.",
          "This organization may not draft with this installation's AI.",
        );
      }),
    };
    renderAt("/example/sources/s1", { braivo });

    fireEvent.click(await screen.findByRole("button", { name: "Draft a course" }));
    expect(
      await screen.findByText("This organization may not draft with this installation's AI."),
    ).toBeTruthy();

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
    const hi = screen.getByRole("checkbox", { name: "Keep “Hi?”" });
    expect(hi.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(retry);

    await vi.waitFor(() =>
      expect(router.history.location.pathname).toBe("/example/courses/course-1"),
    );
    // Sent again as first reviewed, "Hi?" still dropped.
    const [first, second] = braivo.acceptDraft.mock.calls as unknown as unknown[][];
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("Hi?");
  });

  test("lists the organizations the owner is in", async () => {
    renderAt("/organizations");

    const link = await screen.findByRole("link", { name: "Example School" });
    expect(link.getAttribute("href")).toBe("/example");
  });

  test("names the organization in view on its pages, and nowhere else", async () => {
    renderAt("/annex", { organizations: [school, annex], braivo: { listCourses: async () => [] } });
    const current = await screen.findByRole("link", { name: "Annex" });
    expect(current.getAttribute("href")).toBe("/annex");
    cleanup();

    renderAt("/organizations", { organizations: [school, annex] });
    await screen.findByRole("link", { name: "Annex" });
    expect(screen.getAllByRole("link", { name: "Annex" })).toHaveLength(1);
  });

  test("titles an organization's pages so tabs tell apart pages and organizations", async () => {
    const braivo = {
      listCourses: async () => [{ id: "course-1", title: "Beginners" }],
      listSources: async () => [saludos],
      getSource: async () => saludos,
      readCourse,
      learnerProgress: async () => ({ modelVersion: "v1", objectives: [] }),
    };
    const titles = {
      "/example": "Courses · Example School",
      "/example/sources": "Sources · Example School",
      "/example/sources/s1": "Saludos · Source · Example School",
      "/example/courses/course-1": "Beginners · Example School",
      "/example/courses/course-1/learners/u2": "Lee Learner · Beginners · Example School",
      // Nothing found to name: the console's own.
      "/example/courses/elsewhere": "Braivo Console",
    };

    for (const [path, title] of Object.entries(titles)) {
      renderAt(path, { braivo });
      await vi.waitFor(() => expect(document.title).toBe(title));
      cleanup();
    }
  });

  test("says a course is open to the organization's learners, even before they have a site", async () => {
    renderAt("/annex/courses/course-1", { organizations: [annex], braivo: { readCourse } });

    expect(
      await screen.findByText("Open to every learner in Annex, once it has a site to practise on."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
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

    expect(await screen.findByText("No courses published yet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
  });

  test("tells someone who manages no organization where to go, and who they are", async () => {
    renderAt("/organizations", { organizations: [] });

    expect(await screen.findByText("You don't manage any organizations")).toBeTruthy();
    expect(screen.getByText(/Open the site your school/)).toBeTruthy();
    expect(screen.getByText("Signed in as olive@example.com.")).toBeTruthy();
  });

  test("reads a slug that is not one of the owner's organizations as not found", async () => {
    const listCourses = vi.fn();
    renderAt("/elsewhere", { braivo: { listCourses } });

    expect(
      await screen.findByText("This organization does not exist, or you do not manage it."),
    ).toBeTruthy();
    expect(listCourses).not.toHaveBeenCalled();
  });

  test("reads a path below an organization that names no page as nothing, not the organization", async () => {
    renderAt("/example/courses", { braivo: { listCourses: async () => [] } });

    expect(await screen.findByText("There is nothing here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Example School" })).toBeTruthy();
    expect(screen.queryByText(/This organization does not exist/)).toBeNull();
  });

  test("leads from a path that names nothing back to the organizations", async () => {
    renderAt("/organizations/elsewhere");

    fireEvent.click(await screen.findByRole("link", { name: "Organizations" }));

    expect(await screen.findByRole("link", { name: "Example School" })).toBeTruthy();
  });

  test("fails a page that could not load in its place, under the header, until tried again", async () => {
    const listCourses = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([beginners]);
    renderAt("/example", { braivo: { listCourses } });

    const failure = await screen.findByRole("region", { name: "Something went wrong." });
    expect(document.activeElement).toBe(failure);
    expect(screen.getByRole("link", { name: "Example School" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Beginners" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong.")).toBeNull();
  });

  test("shows that a slow first visit is on its way, before any of the page", async () => {
    const loading = Promise.withResolvers<Organization[]>();
    renderAt("/example", {
      braivo: { listOrganizations: () => loading.promise, listCourses: async () => [beginners] },
    });

    expect(await screen.findByRole("status", { name: "Loading" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Example School" })).toBeNull();
    loading.resolve([school]);
    expect(await screen.findByRole("link", { name: "Beginners" }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  test("reads an organization Braivo refuses as not found", async () => {
    renderAt("/example", {
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
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
        learnerProgress,
        listMembers,
      },
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
    // An owner of both organizations could read this report; what they may not
    // do is pair it with another organization's roster.
    expect({
      learnerProgress: learnerProgress.mock.calls,
      listMembers: listMembers.mock.calls,
    }).toEqual({ learnerProgress: [], listMembers: [] });
  });

  test("asks nothing about a course's learners until the course is its own", async () => {
    const progress = vi.fn(courseProgress);
    renderAt("/example/courses/elsewhere", {
      braivo: { readCourse, courseProgress: progress },
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
    expect(progress.mock.calls).toEqual([]);
  });

  test("reads a course as not found when Braivo refuses its learners", async () => {
    renderAt("/example/courses/course-1", {
      braivo: {
        readCourse,
        courseProgress: async () => {
          throw new BraivoError(404, "Braivo answered 404.");
        },
      },
    });

    expect(
      await screen.findByText("This course does not exist, or you do not manage it."),
    ).toBeTruthy();
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

    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Retire “Hello, in Spanish?”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(retireTasks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    const confirming = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirming).getByRole("button", { name: "Retire" }));

    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(2));
    expect(retireTasks).toHaveBeenCalledWith({ organizationId: "org-1", taskIds: ["t1"] });
    // The task is gone with its button, so a keyboard user resumes at its objective.
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" })),
    );
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

    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    expect(await screen.findByText("The task could not be retired. Try again.")).toBeTruthy();
    // Still there to try again, and focused to.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retire" }));
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

    expect(defineTasks).toHaveBeenCalledWith({
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
    });
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

  test("leaves a task as it was when its edit is cancelled, or fails", async () => {
    const defineTasks = vi
      .fn()
      .mockRejectedValueOnce(new BraivoError(503, "Braivo answered 503."))
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
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Hi, in Spanish?");
    expect(document.activeElement).toBe(failed.closest("[role=alert]"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Someone changed or retired this task since the page loaded."),
    ).toBeTruthy();
    expect(defineTasks).toHaveBeenCalledTimes(2);
    // Saving again cannot help: reloading shows the course as stored.
    fireEvent.click(screen.getByRole("button", { name: "Reload the course" }));
    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "1. Greetings" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }),
    );

    await vi.waitFor(() => expect(screen.queryByLabelText("Question")).toBeNull());
    const edit = screen.getByRole("button", { name: "Edit “Hello, in Spanish?”" });
    expect((edit as HTMLButtonElement).disabled).toBe(false);
  });

  test("counts each learner's objectives by standing, linking to their progress", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const learners = await screen.findByRole("table", { name: "Learners" });
    const [header, ...rows] = within(learners).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Learner", "Not started", "Learning", "Retained", "Due for review"]);
    expect(
      rows.map((row) => {
        const learner = within(row).getByRole("rowheader");
        return [
          within(learner).getByRole("link").textContent,
          ...within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ];
      }),
    ).toEqual([
      ["Lee Learner", "0", "1", "0", "1"],
      ["Olive Owner", "2", "0", "0", "0"],
    ]);
    expect(within(rows[0]!).getByText("member")).toBeTruthy();
    expect(within(rows[1]!).getByText("owner")).toBeTruthy();
    expect(within(learners).getByRole("link", { name: "Lee Learner" }).getAttribute("href")).toBe(
      "/example/courses/course-1/learners/u2",
    );
  });

  test("counts each objective's learners by standing, in content order", async () => {
    renderAt("/example/courses/course-1", { braivo: { readCourse } });

    const objectives = await screen.findByRole("table", { name: "Progress by objective" });
    const [header, ...rows] = within(objectives).getAllByRole("row");
    expect(
      within(header!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Objective", "Not started", "Learning", "Retained", "Due for review"]);
    expect(
      rows.map((row) => [
        within(row).getByRole("rowheader").textContent,
        ...within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ]),
    ).toEqual([
      ["Greetings", "1", "1", "0", "0"],
      ["Numbers", "1", "0", "0", "1"],
    ]);
  });

  test("shows where a learner stands on each objective, by title", async () => {
    const report: LearnerProgressReport = {
      modelVersion: "v1",
      objectives: [
        {
          objectiveId: "o1",
          title: "Greetings",
          phase: "retaining",
          lastEvidenceAt: "2026-06-01T00:00:00.000Z",
          stability: 1,
          retrievability: 0.42,
          due: true,
          dueAt: "2026-06-02T00:00:00.001Z",
          evidence: [
            { outcome: "failure", at: "2026-05-30T00:00:00.000Z" },
            { outcome: "failure", at: "2026-05-31T00:00:00.000Z" },
            { outcome: "success", at: "2026-06-01T00:00:00.000Z" },
          ],
        },
        { objectiveId: "o2", title: "Numbers", phase: "unseen", evidence: [] },
      ],
    };
    const learnerProgress = vi.fn(async () => report);
    const listCourses = vi.fn(async () => [{ id: "course-1", title: "Beginners" }]);
    const listMembers = vi.fn(async () => members);
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: { learnerProgress, listCourses, listMembers },
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    // Named in the page, not only the tab, and leading back to the course's other learners.
    expect(screen.getByRole("link", { name: "Beginners" }).getAttribute("href")).toBe(
      "/example/courses/course-1",
    );
    expect(screen.queryByText(/no objectives yet/i)).toBeNull();
    const table = screen.getByRole("table", { name: "Lee Learner" });
    const [header, greetings, numbers] = within(table).getAllByRole("row");
    // The last evidence may have been graded outside Braivo, so not "Last attempted".
    expect(within(header!).getByRole("columnheader", { name: "Last evidence" })).toBeTruthy();
    expect(within(greetings!).getByRole("rowheader", { name: "Greetings" })).toBeTruthy();
    expect(within(greetings!).getByText("Due for review, 42% recall")).toBeTruthy();
    expect(within(header!).getByRole("columnheader", { name: "Review due" })).toBeTruthy();
    expect(
      within(greetings!).getByText(new Date("2026-06-02T00:00:00.001Z").toLocaleString()),
    ).toBeTruthy();
    // Counted, so a learner who failed many times does not read like one who failed once.
    expect(within(header!).getByRole("columnheader", { name: "Evidence" })).toBeTruthy();
    const counted = within(greetings!).getByLabelText("Greetings: 1 success, 2 failures");
    expect(counted.textContent).toBe("1 success, 2 failures");
    // Dated on request, newest first.
    const details = counted.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(counted);
    expect(details.open).toBe(true);
    expect(
      within(greetings!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `${new Date("2026-06-01T00:00:00.000Z").toLocaleString()}: success`,
      `${new Date("2026-05-31T00:00:00.000Z").toLocaleString()}: failure`,
      `${new Date("2026-05-30T00:00:00.000Z").toLocaleString()}: failure`,
    ]);
    expect(within(numbers!).getByText("Not started")).toBeTruthy();
    expect(
      within(numbers!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Not started", "—", "—", "—"]);
    // Every id here is an interchangeable string, so a read scoped to the wrong
    // one type-checks; these assertions are what hold the tenant boundary.
    const options = { signal: expect.any(AbortSignal) };
    expect(learnerProgress).toHaveBeenCalledWith(
      { courseId: "course-1", learnerId: "u2" },
      options,
    );
    expect(listCourses).toHaveBeenCalledWith("org-1", options);
    expect(listMembers).toHaveBeenCalledWith("org-1", options);
  });

  test("reads progress Braivo will not show as not found", async () => {
    renderAt("/example/courses/course-1/learners/u9", {
      braivo: {
        learnerProgress: async () => {
          throw new BraivoError(404, "not found");
        },
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
      },
    });

    expect(
      await screen.findByText("This learner's progress is not yours to see, or does not exist."),
    ).toBeTruthy();
  });

  test("says a course without objectives has nothing to report, rather than an empty table", async () => {
    renderAt("/example/courses/course-1/learners/u2", {
      braivo: {
        learnerProgress: async () => ({ modelVersion: "v1", objectives: [] }),
        listCourses: async () => [{ id: "course-1", title: "Beginners" }],
        listMembers: async () => members,
      },
    });

    expect(await screen.findByRole("heading", { name: "Lee Learner" })).toBeTruthy();
    expect(screen.getByText(/no objectives yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
