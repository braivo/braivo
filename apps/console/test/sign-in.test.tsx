// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale, preferredLocale } from "@braivo/i18n";
import { type BraivoClient, BraivoError } from "@braivo/server/client";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { OPTIONAL_READ_DEADLINE_MS, REQUEST_DEADLINE_MS } from "../lib/deadline.ts";
import { stall, waitOut, renderAt, signInWithCode, signInWithPassword } from "./render.tsx";

describe("the console", () => {
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

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalledWith(expect.objectContaining({ name: "Olive" }));
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

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  describe("signing in with a password", () => {
    test("is offered at /login?method=password alone, and nothing links there", async () => {
      renderAt("/login", {
        signedIn: false,
        braivo: { signInSettings: async () => ({ google: true }) },
      });
      await screen.findByLabelText("Email address");
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(document.querySelector('a[href*="password"]')).toBeNull();
      cleanup();

      const { router } = renderAt("/login?method=password&redirect=%2Fexample", {
        signedIn: false,
        braivo: { listCourses: async () => [] },
      });
      await signInWithPassword();

      expect(await screen.findByText("No courses yet")).toBeTruthy();
      expect(router.history.location.pathname).toBe("/example");
    });
  });

  describe("signing in with Google", () => {
    const withGoogle = { signInSettings: async () => ({ google: true }) };

    test("is offered when the installation has it, and comes back where sign-in was headed", async () => {
      const { auth } = renderAt("/login?redirect=%2Fdevice", {
        signedIn: false,
        braivo: withGoogle,
      });

      fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

      expect(auth.signIn.social).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          callbackURL: "/device",
          errorCallbackURL: "/login?redirect=%2Fdevice",
        }),
      );
    });

    test("is asked about while the session is read, not after", async () => {
      let answer!: () => void;
      const signInSettings = vi.fn(async () => ({ google: true }));
      renderAt("/login", {
        braivo: { signInSettings },
        getSession: () =>
          new Promise((resolve) => {
            answer = () => resolve({ data: null, error: null });
          }),
      });

      await vi.waitFor(() => expect(signInSettings).toHaveBeenCalled());
      answer();
      expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeTruthy();
    });

    test("is not offered when the installation lacks it, or cannot say", async () => {
      renderAt("/login", { signedIn: false });
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
      cleanup();

      renderAt("/login", {
        signedIn: false,
        braivo: { signInSettings: () => Promise.reject(new TypeError("Failed to fetch")) },
      });
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    });

    test("offers codes alone when the installation does not say in time", async () => {
      vi.useFakeTimers();
      renderAt("/login", {
        signedIn: false,
        braivo: { signInSettings: (options?: { signal?: AbortSignal }) => stall(options) },
      });
      await waitOut(OPTIONAL_READ_DEADLINE_MS - 1);
      expect(screen.queryByLabelText("Email address")).toBeNull();
      await waitOut(1);
      vi.useRealTimers();

      expect(await screen.findByLabelText("Email address")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    });

    test("signs in afresh when the session cannot be read in time", async () => {
      vi.useFakeTimers();
      renderAt("/login", {
        getSession: (options?: { fetchOptions?: { signal?: AbortSignal } }) =>
          stall(options?.fetchOptions),
      });
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect(await screen.findByLabelText("Email address")).toBeTruthy();
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

      expect(auth.signIn.social).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          callbackURL: "/login?handoff=h1",
          errorCallbackURL: "/login?handoff=h1",
        }),
      );
    });

    test("for a learn domain whose learner chose Google there, starts it at once, offering an open account first", async () => {
      const fernwood = { organization: { name: "Fernwood" }, hostname: "learn.fernwood.example" };
      const { auth } = renderAt("/login?handoff=h1&provider=google", {
        signedIn: false,
        braivo: { ...withGoogle, handoff: async () => fernwood },
      });

      await vi.waitFor(() =>
        expect(auth.signIn.social).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "google",
            // Back without `provider`, so it never starts again by itself.
            callbackURL: "/login?handoff=h1",
            errorCallbackURL: "/login?handoff=h1",
          }),
        ),
      );
      expect(auth.signIn.social).toHaveBeenCalledOnce();
      expect(screen.queryByLabelText("Email address")).toBeNull();
      cleanup();

      // An account open here is offered first, as always.
      const signedIn = renderAt("/login?handoff=h1&provider=google", {
        braivo: { ...withGoogle, handoff: async () => fernwood },
      });
      expect(await screen.findByRole("button", { name: "Continue as Olive Owner" })).toBeTruthy();
      expect(signedIn.auth.signIn.social).not.toHaveBeenCalled();
    });

    test("for a learn domain, when starting the learner's choice of Google fails, offers the form", async () => {
      const fernwood = { organization: { name: "Fernwood" }, hostname: "learn.fernwood.example" };
      const { auth } = renderAt("/login?handoff=h1&provider=google", {
        signedIn: false,
        braivo: { ...withGoogle, handoff: async () => fernwood },
      });
      auth.signIn.social.mockResolvedValueOnce({ error: { status: 500 } });

      expect(
        await screen.findByText(
          "Could not sign in with Google. Try again, or sign in with a code.",
        ),
      ).toBeTruthy();
      expect(screen.getByLabelText("Email address")).toBeTruthy();
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
      fireEvent.change(screen.getByLabelText("Email address"), {
        target: { value: "owner@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
      // Past the email step, whose heading named them, both are still named.
      await screen.findByRole("heading", { name: "Check your email" });
      expect(screen.getByText("Fernwood")).toBeTruthy();
      expect(screen.getByText(/learn\.fernwood\.example/)).toBeTruthy();
      expect(screen.queryByText(/Braivo/)).toBeNull();
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });

      await vi.waitFor(() => expect(visit).toHaveBeenCalledWith(url));
      expect(completeHandoff).toHaveBeenCalledWith("h1", expect.anything());
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
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
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
      expect(await screen.findByLabelText("Email address")).toBeTruthy();
    });

    test("keeps the account offered when signing out of it does not finish in time", async () => {
      const { auth } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood },
      });
      auth.signOut.mockImplementationOnce((options?: { fetchOptions?: { signal?: AbortSignal } }) =>
        stall(options?.fetchOptions),
      );
      const another = await screen.findByRole("button", { name: "Use another account" });

      vi.useFakeTimers();
      fireEvent.click(another);
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      expect(await screen.findByText("Could not sign out. Try again.")).toBeTruthy();
      expect(another.getAttribute("aria-disabled")).toBe("false");
      expect(screen.getByRole("button", { name: "Continue as Olive Owner" })).toBeTruthy();
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

      expect(await screen.findByLabelText("Email address")).toBeTruthy();
    });

    test("lets another person switch from an account left without a name, naming nothing", async () => {
      const { auth } = renderAt("/login?handoff=h1", {
        name: "",
        braivo: { handoff: async () => fernwood, completeHandoff: async () => url },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Use another account" }));

      expect(await screen.findByLabelText("Email address")).toBeTruthy();
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
      expect(screen.getByLabelText("Email address")).toBeTruthy();
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

    test("switches language from its menu at once, keeping what was typed, and remembers it", async () => {
      onTestFinished(async () => {
        localStorage.clear();
        await activateLocale("en");
      });
      renderAt("/login", { signedIn: false });
      fireEvent.change(await screen.findByLabelText("Email address"), {
        target: { value: "owner@example.com" },
      });

      const menu = screen.getByRole("button", { name: "Language: English" });
      fireEvent.keyDown(menu, { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Polski" }));

      expect(await screen.findByRole("heading", { name: "Zaloguj się" })).toBeTruthy();
      expect((screen.getByLabelText("Adres e-mail") as HTMLInputElement).value).toBe(
        "owner@example.com",
      );
      expect(screen.getByRole("button", { name: "Język: Polski" })).toBeTruthy();
      expect(preferredLocale(["en-GB"])).toBe("pl");
    });

    test("speaks the browser's language on the console's own sign-in, which keeps its name", async () => {
      onTestFinished(() => activateLocale("en"));
      await activateLocale(chooseLocale(["pl-PL", "en"]));
      renderAt("/login", { signedIn: false });

      expect(await screen.findByRole("heading", { name: "Zaloguj się" })).toBeTruthy();
      // The console's name stays, in every language.
      expect(screen.getByText("Braivo Console")).toBeTruthy();
      expect(screen.getByText(/^Ucz raz\./)).toBeTruthy();
      expect(screen.getByText("Jesteś uczniem?")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Motyw" })).toBeTruthy();
      expect(screen.getByText("Do powtórki")).toBeTruthy();
    });

    test("sets up an organization in the chosen language, wording a refusal from its code", async () => {
      onTestFinished(() => activateLocale("en"));
      await activateLocale(chooseLocale(["pl-PL", "en"]));
      const setUpOrganization = vi.fn(async () => {
        // Braivo's English, never shown: the code is worded instead.
        const taken = "laka.braivo.app is taken. Choose another address.";
        throw new BraivoError(409, "Braivo answered 409", taken, "ADDRESS_TAKEN");
      });
      renderAt("/join", {
        organizations: [],
        braivo: {
          organizationSetup: async () => ({
            domain: "braivo.app",
            maySetUp: true,
            dataRegion: "EU",
            otherRegions: [{ region: "US", setupUrl: null }],
          }),
          setUpOrganization,
        },
      });

      expect(
        await screen.findByRole("heading", { level: 1, name: "Załóż swoją organizację" }),
      ).toBeTruthy();
      // Regions' names are the browser's, in the chosen language.
      expect(screen.getByRole("option", { name: "Unia Europejska" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Stany Zjednoczone (wkrótce)" })).toBeTruthy();
      expect(screen.getByText(/o dodanie adresu olive@example\.com\.$/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Nazwa organizacji"), { target: { value: "Łąka" } });
      fireEvent.click(screen.getByRole("button", { name: "Utwórz organizację" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Adres laka.braivo.app jest już zajęty. Wybierz inny.",
      );
      expect(screen.getByLabelText("Strona dla uczniów")).toBeTruthy();
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
      renderAt("/login", { signedIn: false, braivo: { signInSettings: () => methods.promise } });
      expect(
        await screen.findByRole("status", { name: "Ładowanie" }, { timeout: 2000 }),
      ).toBeTruthy();
      methods.resolve({ google: false });
      expect(await screen.findByLabelText("Adres e-mail")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Wyślij mi kod" })).toBeTruthy();
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

    test("offers to try again when the handoff cannot be read in time", async () => {
      const handoff = vi
        .fn<BraivoClient["handoff"]>()
        .mockImplementationOnce((_id, options) => stall(options))
        .mockResolvedValue(fernwood);
      vi.useFakeTimers();
      renderAt("/login?handoff=h1", { braivo: { handoff } });
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("button", { name: "Continue as Olive Owner" })).toBeTruthy();
    });

    test("offers to continue again when Braivo does not answer in time", async () => {
      const completeHandoff = vi
        .fn<BraivoClient["completeHandoff"]>()
        .mockImplementationOnce((_id, options) => stall(options))
        .mockResolvedValue(url);
      const { visit } = renderAt("/login?handoff=h1", {
        braivo: { handoff: async () => fernwood, completeHandoff },
      });
      const offered = await screen.findByRole("button", { name: "Continue as Olive Owner" });

      vi.useFakeTimers();
      fireEvent.click(offered);
      await waitOut(REQUEST_DEADLINE_MS);
      vi.useRealTimers();

      // Continuing again is safe: it replaces a code issued meanwhile (access-14).
      expect(
        await screen.findByText("Could not connect. Check your connection and try again."),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Continue as Olive Owner" }));
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
      expect(screen.queryByLabelText("Email address")).toBeNull();
      // Nothing says where it came from.
      expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
      // Not Braivo's name or colours, on the way back to an organization's site.
      expect(heading.closest("[data-learn-domain]")).toBeTruthy();
      await vi.waitFor(() => expect(document.title).toBe("This sign-in has expired"));
    });

    test("asks agreement to the operator's legal pages where it has them, on either sign-in", async () => {
      const legal = {
        privacy: "https://fernwood.example/privacy",
        terms: "https://fernwood.example/terms",
      };
      const braivo = {
        signInSettings: async () => ({ google: false, legal }),
        handoff: async () => fernwood,
      };
      for (const path of ["/login", "/login?handoff=h1"]) {
        renderAt(path, { signedIn: false, braivo });
        await screen.findByLabelText("Email address");
        const agreement = screen.getByText(/By continuing, you agree to the/);
        expect(agreement.textContent).toBe(
          "By continuing, you agree to the Terms and Privacy Policy.",
        );
        // In a new tab, keeping the email typed.
        for (const [name, href] of [
          ["Terms", legal.terms],
          ["Privacy Policy", legal.privacy],
        ]) {
          const link = within(agreement).getByRole("link", { name });
          expect(link.getAttribute("href")).toBe(href);
          expect(link.getAttribute("target")).toBe("_blank");
        }
        cleanup();
      }

      // An installation without them asks agreement to nothing.
      renderAt("/login", { signedIn: false });
      await screen.findByLabelText("Email address");
      expect(screen.queryByText(/By continuing/)).toBeNull();
    });

    test("frames the console's own sign-in with Braivo's pitch, and a learn domain's with its organization alone", async () => {
      renderAt("/login", { signedIn: false });
      const heading = await screen.findByRole("heading", { name: "Sign in" });
      expect(screen.getByText(/^Teach it once\./)).toBeTruthy();
      // The form's heading is the page's only one: the pitch beside it is not
      // where a screen reader's heading navigation should land first.
      expect(screen.getAllByRole("heading")).toEqual([heading]);
      expect(screen.getByText("Here to learn?")).toBeTruthy();
      // The page's own frame, not the column of the console's other pages.
      expect(heading.closest("main")!.className).not.toContain("max-w-3xl");
      cleanup();

      // Signing in, and offered the account already signed in.
      for (const signedIn of [false, true]) {
        renderAt("/login?handoff=h1", { signedIn, braivo: { handoff: async () => fernwood } });
        await screen.findByRole("heading", { name: "Sign in to Fernwood" });
        expect(screen.getByText("Fernwood")).toBeTruthy();
        expect(screen.getByText("You will continue at learn.fernwood.example.")).toBeTruthy();
        expect(screen.queryByText(/braivo|console|teach it once|here to learn/i)).toBeNull();
        cleanup();
      }
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
      const heading = await screen.findByRole("heading", { name: "Sign in" });
      expect(heading.closest("[data-learn-domain]")).toBeNull();
    });

    test("marks the whole page as a learn domain's only while on its sign-in, whatever marked it first", async () => {
      // As `public/head.js` does before the app starts, on an empty handoff too.
      document.documentElement.dataset.learnDomain = "";
      const fernwood = { organization: { name: "Fernwood" }, hostname: "learn.fernwood.example" };
      const { router } = renderAt("/login?handoff=", {
        signedIn: false,
        braivo: { handoff: async () => fernwood },
      });
      await screen.findByRole("heading", { name: "Sign in" });
      expect(document.documentElement.hasAttribute("data-learn-domain")).toBe(false);

      await router.navigate({ to: "/login", search: { handoff: "h1" } });
      await screen.findByRole("heading", { name: "Sign in to Fernwood" });
      expect(document.documentElement.hasAttribute("data-learn-domain")).toBe(true);

      // Left without a reload, Braivo's theme is back.
      await router.navigate({ to: "/login" });
      await screen.findByRole("heading", { name: "Sign in" });
      expect(document.documentElement.hasAttribute("data-learn-domain")).toBe(false);
    });
  });

  test("sends an owner already signed in on from /login, to where it would have led", async () => {
    // Back after signing in, or a bookmark: no form for an account already in,
    // nor a wait for the sign-in settings it would have shown.
    const { router } = renderAt("/login?redirect=%2Fexample", {
      braivo: { listCourses: async () => [], signInSettings: () => new Promise(() => {}) },
    });
    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(router.history.location.pathname).toBe("/example");
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  test("returns an owner to the page they asked for once they sign in", async () => {
    const { auth, router } = renderAt("/example", {
      signedIn: false,
      braivo: { listCourses: async () => [] },
    });

    await screen.findByLabelText("Email address");
    expect(router.history.location.pathname).toBe("/login");
    await signInWithCode();

    expect(await screen.findByText("No courses yet")).toBeTruthy();
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        type: "sign-in",
        fetchOptions: expect.objectContaining({ headers: { "Accept-Language": "en" } }),
      }),
    );
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "owner@example.com", otp: "123456" }),
    );
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(router.history.location.pathname).toBe("/example");
    // `/login` was replaced, so Back leaves rather than return to it.
    expect(router.history.location.state.__TSR_index).toBe(0);
  });
});
