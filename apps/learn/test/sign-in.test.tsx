// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale } from "@braivo/i18n";
import { BraivoError } from "@braivo/server/client";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { OPTIONAL_READ_DEADLINE_MS, READ_DEADLINE_MS } from "../lib/deadline.ts";
import { stall, waitOut, renderAt } from "./render.tsx";

describe("the learn app", () => {
  test("sends a signed-out learner to sign in, and asks Braivo nothing", async () => {
    const { learnerProgress, nextActivity, router } = renderAt("/c/4732", {
      signedIn: false,
    });

    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/c/4732" });
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
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
    });

    expect(await screen.findByRole("region", { name: "Something went wrong." })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(learnerCourses).not.toHaveBeenCalled();

    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
  });

  test("on its organization's domain, signs in there by its own code, under its name, and returns where they were headed", async () => {
    const { sendSignInCode, signInWithCode, router, visit } = renderAt("/", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
    });

    expect(await screen.findByRole("heading", { name: "Sign in to Fernwood" })).toBeTruthy();
    // Its brand in Braivo's place, in the tab too.
    expect(screen.getByText("Fernwood")).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Sign in · Fernwood"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });

    expect(await screen.findByRole("link", { name: "Spanish" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    // In the page's language, which the server mails in.
    expect(sendSignInCode).toHaveBeenCalledWith(
      "ada@example.com",
      expect.objectContaining({ headers: { "Accept-Language": "en" } }),
    );
    expect(signInWithCode).toHaveBeenCalledWith("ada@example.com", "123456", expect.anything());
    expect(visit).not.toHaveBeenCalled();
  });

  test("on its organization's domain, says a non-member's right code works once they are added", async () => {
    renderAt("/login", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
      signInWithCode: async () => {
        throw new BraivoError(403, "not a member", undefined, "NOT_A_MEMBER");
      },
    });

    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "eve@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });

    expect(
      await screen.findByText(
        "This email has not been added here yet. Ask to have it added, then sign in again: this code works until it expires.",
      ),
    ).toBeTruthy();
    // Kept, to send again once added.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123456");
  });

  test("on its organization's domain, leaves for Google through the installation's origin, when offered", async () => {
    const { visit } = renderAt("/login?redirect=%2Fc%2F4732", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
      signInSettings: async () => ({ google: true, legal: null }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    expect(visit).toHaveBeenCalledWith("/api/session/sign-in?redirect=%2Fc%2F4732&provider=google");
  });

  test("on its organization's domain, sends a learner already signed in onward, without a second handoff", async () => {
    const { router, visit } = renderAt("/login?redirect=%2Fc%2F4732", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/c/4732"));
    expect(visit).not.toHaveBeenCalled();
    await router.navigate({ to: "/login", search: { redirect: "/" } });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));

    // The router puts a redirect in `/login`'s place, so Back moves past it.
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/c/4732"));
  });

  test("on its organization's domain, asks an unnamed learner signed in there for a name, then goes on", async () => {
    const { nameAccount, router } = renderAt("/login", {
      signedIn: true,
      user: { id: "ada", name: "" },
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(nameAccount).toHaveBeenCalledWith("Ada", expect.anything());
  });

  test("on its organization's domain, goes on when the account was named meanwhile, rather than asking again", async () => {
    // Named by a request whose answer was lost, or in another tab.
    let named = false;
    const { nameAccount, router } = renderAt("/login", {
      signedIn: true,
      session: async () => ({ id: "ada", name: named ? "Ada" : "" }),
      hostOrganization: async () => ({ name: "Fernwood" }),
    });
    nameAccount.mockImplementationOnce(async () => {
      named = true;
      throw new BraivoError(409, "named", undefined, "ALREADY_NAMED");
    });

    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  test("on its organization's domain, after Google's round trip failed, says so on the form, leaving only on a click", async () => {
    const { visit } = renderAt("/login?failed=1", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
      signInSettings: async () => ({ google: true, legal: null }),
    });

    expect(
      await screen.findByText("Could not sign in with Google. Try again, or sign in with a code."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(visit).not.toHaveBeenCalled();
  });

  test("on its organization's domain, still says Google's round trip failed once Google is not offered", async () => {
    renderAt("/login?failed=1", {
      signedIn: false,
      hostOrganization: async () => ({ name: "Fernwood" }),
      signInSettings: async () => ({ google: false, legal: null }),
    });

    expect(
      await screen.findByText("Could not sign in with Google. Try again, or sign in with a code."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
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
      expect(await screen.findByRole("heading", { name: "Sign in to Fernwood" })).toBeTruthy();
      expect(visit).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(document.title).toBe("Zaloguj się"));
    expect(screen.getByLabelText("Adres e-mail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wyślij mi kod" })).toBeTruthy();
    cleanup();

    renderAt("/login?failed=1", {
      signedIn: false,
      hostOrganization: fernwood,
      signInSettings: async () => ({ google: true, legal: null }),
    });
    expect(await screen.findByRole("heading", { name: "Logowanie: Fernwood" })).toBeTruthy();
    await vi.waitFor(() => expect(document.title).toBe("Zaloguj się · Fernwood"));
    expect(
      screen.getByText(
        "Nie udało się zalogować przez Google. Spróbuj ponownie lub zaloguj się kodem.",
      ),
    ).toBeTruthy();
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
  });

  test("signs a learner out of this domain, then back to sign in", async () => {
    const { signOut } = renderAt("/", {
      signedIn: true,
      hostOrganization: async () => ({ name: "Fernwood" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in to Fernwood" })).toBeTruthy();
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
    await vi.waitFor(() => expect(document.title).toBe("Sign in"));
  });

  test("stays usable, unbranded, when the brand cannot be read", async () => {
    renderAt("/", {
      signedIn: true,
      hostOrganization: async () => {
        throw new BraivoError(500, "down");
      },
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
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
    expect(await screen.findByRole("heading", { name: "Sign in to Fernwood" })).toBeTruthy();
    expect(visit).not.toHaveBeenCalled();
  });

  test("signs a learner in with an emailed code, and returns them where they were headed", async () => {
    const { learnerCourses, router } = renderAt("/", {
      signedIn: false,
      learnerCourses: async () => [
        { id: "c1", number: 4732, title: "Spanish", urlLabel: "spanish" },
      ],
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
});
