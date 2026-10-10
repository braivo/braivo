// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale, LocalizationProvider } from "@braivo/i18n";
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { SignIn, type SignInAuth } from "./sign-in.tsx";

afterEach(() => {
  // First: a test failing on fake timers would leave them to the cleanup, and the next test.
  vi.useRealTimers();
  cleanup();
});

/** Under the provider the apps put around marked copy, with the setup's English active. */
const render = (ui: ReactNode) => renderBare(ui, { wrapper: LocalizationProvider });

/** A client accepting every step, for an account named `name`. */
function fakeAuth(name: string) {
  return {
    emailOtp: {
      sendVerificationOtp: vi.fn<SignInAuth["emailOtp"]["sendVerificationOtp"]>(async () => ({
        error: null,
      })),
    },
    signIn: {
      emailOtp: vi.fn<SignInAuth["signIn"]["emailOtp"]>(async () => ({
        data: { user: { name } },
        error: null,
      })),
      social: vi.fn<SignInAuth["signIn"]["social"]>(async () => ({ error: null })),
    },
    updateUser: vi.fn<SignInAuth["updateUser"]>(async () => ({ error: null })),
  };
}

/** What every request carries: its deadline's signal. */
const bounded = { fetchOptions: { signal: expect.any(AbortSignal) } };

/** A request with no answer, rejecting once its signal aborts, as `fetch` does. */
function stall(input: { fetchOptions?: { signal?: AbortSignal } }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = input.fetchOptions?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Starts a request that will stall, and lets access-5's 10 seconds pass on fake timers. */
async function stalled(start: () => void) {
  vi.useFakeTimers();
  start();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  vi.useRealTimers();
}

/** Braivo's refusal of a second code within a minute (`apps/server/auth`). */
const cooldown = {
  code: "SIGN_IN_CODE_COOLDOWN",
  status: 429,
  message: "Wait a minute before asking for a code again.",
};

const google = { callbackURL: "/courses", errorCallbackURL: "/login?redirect=%2Fcourses" };

/**
 * Moves the clock past the server's minute between codes, which the form
 * counts down before offering another. Only `Date`: the form's tick stays real.
 */
function passMinute() {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(Date.now() + 60_000);
}

/** The note saying where the code went, once it reads as `text` says. */
const findSent = (text: RegExp | string) =>
  screen.findByText(
    (_, element) =>
      element?.getAttribute("role") === "status" &&
      (typeof text === "string"
        ? element.textContent === text
        : text.test(element.textContent ?? "")),
  );

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Asks for a code for `learner@example.com`, and enters `123456`, which submits it. */
async function enterCode() {
  fill("Email address", "learner@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
  await screen.findByLabelText("Code");
  fill("Code", "123456");
}

describe("SignIn", () => {
  test("sends a code to the email given, and signs in with it", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await findSent(/Enter the six-digit code sent to learner@example.com/)).toBeTruthy();
    // Its last digit submits it, with no Sign in pressed.
    fill("Code", "123456");

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "learner@example.com",
      type: "sign-in",
      fetchOptions: { ...bounded.fetchOptions, headers: { "Accept-Language": "en" } },
    });
    expect(auth.signIn.emailOtp).toHaveBeenCalledExactlyOnceWith({
      email: "learner@example.com",
      otp: "123456",
      ...bounded,
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  test("takes a code pasted with spaces or a dash, and signs in with it", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));

    fireEvent.paste(await screen.findByLabelText("Code"), {
      clipboardData: { getData: () => " 123-456\n" },
    });
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith({
      email: "learner@example.com",
      otp: "123456",
      ...bounded,
    });
  });

  test("asks a new account for its name before it is signed in", async () => {
    const auth = fakeAuth("");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

    await enterCode();
    await screen.findByLabelText("Your name");
    fill("Your name", "Ada");
    expect(onSignedIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.updateUser).toHaveBeenCalledWith({ name: "Ada", ...bounded });
  });

  test("starts at the name for a session whose account has none", async () => {
    const auth = fakeAuth("");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} needsName onSignedIn={onSignedIn} />);

    fill("Your name", "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  test("goes back to the email when the session ended before the name", async () => {
    const auth = fakeAuth("");
    // Signed out in another tab: naming would be refused however often tried.
    auth.updateUser.mockResolvedValue({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} needsName onSignedIn={onSignedIn} />);

    fill("Your name", "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You were signed out. Sign in again.",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("says plainly why a code was refused, and stays on it", async () => {
    const onSignedIn = vi.fn();
    const auth = fakeAuth("Ada");
    auth.signIn.emailOtp.mockResolvedValue({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP" },
    });
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

    await enterCode();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code is not right. Check it, or send a new one.",
    );
    // Cleared, so the next is typed afresh, after each refusal.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("");
    fill("Code", "654321");
    await vi.waitFor(() =>
      expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe(""),
    );
    expect(onSignedIn).not.toHaveBeenCalled();

    // Back to the email, still filled in, to send a new one.
    fireEvent.click(screen.getByRole("button", { name: /Use another email/ }));
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
      "learner@example.com",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("offers a new code in place of one that can sign in no more", async () => {
    for (const code of ["OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]) {
      const auth = fakeAuth("Ada");
      auth.signIn.emailOtp.mockResolvedValueOnce({ data: null, error: { code, message: code } });
      const onSignedIn = vi.fn();
      render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

      await enterCode();
      await screen.findByRole("alert");
      expect((screen.getByLabelText("Code") as HTMLInputElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      // Still within the minute of the first code: locked until it is over.
      const resend = screen.getByRole("button", { name: "Send a new code" });
      expect(resend.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(resend);
      expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledOnce();

      passMinute();
      fireEvent.click(resend);
      await findSent(/A new code was sent to learner@example.com/);
      expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
      fill("Code", "654321");
      await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
      cleanup();
      vi.useRealTimers();
    }

    // A wrong code can still be typed again.
    const auth = fakeAuth("Ada");
    auth.signIn.emailOtp.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP" },
    });
    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
    await enterCode();
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Code") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  test("sends a new code from the code step, which stays there if that is refused", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    await screen.findByLabelText("Code");

    fill("Code", "123");
    // Within the minute of the first, nothing is asked: the server would refuse.
    const resend = screen.getByRole("button", { name: "Send a new code" });
    fireEvent.click(resend);
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledOnce();
    // Past it, another tab may have asked meanwhile, or the mail failed: either
    // way the server's minute starts again, and so does the wait here.
    const refusals = [
      { error: cooldown, says: "Wait a minute before asking for a code again." },
      {
        error: { code: "SIGN_IN_CODE_SEND_FAILED", status: 503, message: "Not sent." },
        says: "The code could not be sent. Try again in a minute.",
      },
    ];
    for (const { error, says } of refusals) {
      passMinute();
      auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({ error });
      const calls = auth.emailOtp.sendVerificationOtp.mock.calls.length;
      fireEvent.click(resend);
      await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(says));
      fireEvent.click(resend);
      expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(calls + 1);
    }
    expect(screen.queryByText(/A new code was sent/)).toBeNull();
    // The first code still works, so what was typed of it is kept.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123");
    fill("Code", "123456");
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    cleanup();

    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    await screen.findByLabelText("Code");
    fill("Code", "111");
    passMinute();
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await findSent(/A new code was sent to learner@example.com/)).toBeTruthy();
    // The old code is gone, so Sign in cannot spend a guess on it.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("");
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenLastCalledWith({
      email: "learner@example.com",
      type: "sign-in",
      fetchOptions: { ...bounded.fetchOptions, headers: { "Accept-Language": "en" } },
    });
  });

  test("goes on to a code sent within the minute, rather than stay at the email", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    // Asked for after Back, a reload, or in another tab: the server refuses a
    // second, and the first still signs in.
    auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({ error: cooldown });
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "A code was requested less than a minute ago. Check your email.",
    );
    expect(alert.className).not.toContain("text-destructive");
    expect(await findSent(/Enter the six-digit code sent to learner@example.com/)).toBeTruthy();
    // Its minute is counted down, as after a send.
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledOnce();
    fill("Code", "123456");
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith({
      email: "learner@example.com",
      otp: "123456",
      ...bounded,
    });
  });

  test("stays at the email when the minute is that of a send that failed", async () => {
    const auth = fakeAuth("Ada");
    auth.emailOtp.sendVerificationOtp
      .mockResolvedValueOnce({
        error: { code: "SIGN_IN_CODE_SEND_FAILED", status: 503, message: "Not sent." },
      })
      .mockResolvedValueOnce({ error: cooldown });
    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
    fill("Email address", "Learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    await screen.findByText("The code could not be sent. Try again in a minute.");

    // No code went out, so there is none to go on to.
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    await screen.findByText("Wait a minute before asking for a code again.");
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  test("words a refusal from its code or status, never in the server's words, calm for a wait", async () => {
    const auth = fakeAuth("Ada");
    const shown = async (error: { code?: string; status: number; message: string }) => {
      auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({ error });
      render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
      fill("Email address", "learner@example.com");
      fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
      const alert = await screen.findByRole("alert");
      // Still at the email, to ask again.
      expect(screen.getByLabelText("Email address")).toBeTruthy();
      const shown = {
        says: alert.textContent,
        // Only a fault is shown as an error; a limit asks only to wait.
        error: alert.className.includes("text-destructive"),
      };
      cleanup();
      return shown;
    };

    // Braivo's, when the mail server refused the code.
    expect(
      await shown({ code: "SIGN_IN_CODE_SEND_FAILED", status: 503, message: "Not sent." }),
    ).toEqual({ says: "The code could not be sent. Try again in a minute.", error: true });
    // Better Auth's own rate limit answers with no code.
    expect(
      await shown({ status: 429, message: "Too many requests. Please try again later." }),
    ).toEqual({ says: "Too many tries. Wait a minute, then try again.", error: false });
    expect(await shown({ code: "SOMETHING_NEW", status: 400, message: "Something new." })).toEqual({
      says: "That did not work. Try again.",
      error: true,
    });
  });

  test("lets the learner try again after a request that got no answer", async () => {
    const auth = fakeAuth("Ada");
    auth.emailOtp.sendVerificationOtp.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);

    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not connect. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Send me a code" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("keeps a code whose check got no answer, or another refusal, to try again", async () => {
    const auth = fakeAuth("Ada");
    auth.signIn.emailOtp
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        data: null,
        error: { code: "SOMETHING_NEW", status: 400, message: "Something new." },
      });
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
    const code = () => (screen.getByLabelText("Code") as HTMLInputElement).value;

    await enterCode();
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not connect/);
    expect(code()).toBe("123456");
    // Not resent by itself: only a change to the code, or Sign in, sends it.
    expect(auth.signIn.emailOtp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("That did not work. Try again.");
    expect(code()).toBe("123456");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  test("lets the person try each step again once it got no answer in time", async () => {
    const auth = fakeAuth("");
    auth.signIn.social
      .mockImplementationOnce(stall)
      .mockResolvedValueOnce({ error: { message: "Provider not found" } });
    auth.emailOtp.sendVerificationOtp.mockImplementationOnce(stall);
    auth.signIn.emailOtp.mockImplementationOnce(stall);
    auth.updateUser.mockImplementationOnce(stall);
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} google={google} />);
    const alert = async () => (await screen.findByRole("alert")).textContent;
    const unanswered = "Could not connect. Check your connection and try again.";

    const googleButton = screen.getByRole("button", { name: "Continue with Google" });
    await stalled(() => fireEvent.click(googleButton));
    expect(await alert()).toBe(unanswered);
    fireEvent.click(googleButton);
    expect(await screen.findByText(/^Could not sign in with Google/)).toBeTruthy();
    expect(auth.signIn.social).toHaveBeenCalledTimes(2);

    fill("Email address", "learner@example.com");
    await stalled(() => fireEvent.click(screen.getByRole("button", { name: "Send me a code" })));
    expect(await alert()).toBe(unanswered);
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));

    await screen.findByLabelText("Code");
    await stalled(() => fill("Code", "123456"));
    expect(await alert()).toBe(unanswered);
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByLabelText("Your name");
    fill("Your name", "Ada");
    await stalled(() => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
    expect(await alert()).toBe(unanswered);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  test("offers Google at the email step alone", async () => {
    render(<SignIn auth={fakeAuth("Ada")} onSignedIn={() => {}} google={google} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();

    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    await screen.findByLabelText("Code");

    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  test("offers Google only when asked to, and sends the person there to come back", async () => {
    const auth = fakeAuth("Ada");
    render(<SignIn auth={auth} onSignedIn={() => {}} />);
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    cleanup();

    render(<SignIn auth={auth} onSignedIn={() => {}} google={google} />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(auth.signIn.social).toHaveBeenCalledExactlyOnceWith({
      provider: "google",
      ...google,
      ...bounded,
    });
    // Leaving for Google: its button spins, and nothing else may start meanwhile.
    await vi.waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(within(button).getByRole("status")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: "Send me a code" })).queryByRole("status"),
    ).toBeNull();
    fill("Email address", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(auth.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  test("says why Google sent the person back", () => {
    const auth = fakeAuth("Ada");
    const shown = (error: string) => {
      render(<SignIn auth={auth} onSignedIn={() => {}} google={{ ...google, error }} />);
      const alert = screen.queryByRole("alert")?.textContent;
      cleanup();
      return alert;
    };

    // Cancelled, or blocked by the school's administrator: Google says the same.
    expect(shown("access_denied")).toBe(
      "Could not sign in with Google. Try again, or sign in with a code.",
    );
    for (const unverified of ["email_not_verified", "account_not_linked"]) {
      expect(shown(unverified)).toBe(
        "Your Google account's email is not verified. Sign in with a code instead.",
      );
    }
    expect(shown("email_changed")).toMatch(/^Your Google account's email no longer matches/);
    expect(shown("invalid_code")).toBe(
      "Could not sign in with Google. Try again, or sign in with a code.",
    );
  });

  test("speaks the browser's language at every step, refusals included", async () => {
    onTestFinished(() => activateLocale("en"));
    await activateLocale(chooseLocale(["pl-PL", "en"]));
    const auth = fakeAuth("");
    auth.signIn.emailOtp.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_OTP", status: 400, message: "Invalid OTP" },
    });
    render(<SignIn auth={auth} onSignedIn={() => {}} google={google} />);

    expect(screen.getByRole("button", { name: "Kontynuuj z Google" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Zaloguj się" })).toBeTruthy();
    expect(screen.getByText("lub")).toBeTruthy();
    expect(screen.getByText("Jesteś tu pierwszy raz? Logowanie utworzy Twoje konto.")).toBeTruthy();
    // The browser's own word for an invalid email would be in its language.
    const email = screen.getByLabelText("Adres e-mail") as HTMLInputElement;
    fireEvent.invalid(email);
    expect(email.validationMessage).toBe("Wpisz swój adres e-mail, np. imie@example.com.");
    fill("Adres e-mail", "learner@example.com");
    expect(email.validationMessage).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Wyślij mi kod" }));
    // The mail in the page's language, whatever the browser asks for.
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchOptions: expect.objectContaining({ headers: { "Accept-Language": "pl" } }),
      }),
    );
    await findSent(
      "Wpisz sześciocyfrowy kod wysłany na adres learner@example.com. Wygasa po 10 minutach i działa tylko raz.",
    );
    expect(screen.getByRole("heading", { name: "Sprawdź pocztę" })).toBeTruthy();
    // The wait before another code, in Polish word order.
    expect(screen.getByRole("button", { name: "Wyślij nowy kod" }).textContent).toBe(
      "Wyślij nowy kodza 1:00",
    );
    expect(
      screen.getByText("Zalogujesz się, gdy tylko wpiszesz wszystkie sześć cyfr."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zaloguj się" })).toBeTruthy();
    fill("Kod", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ten kod jest nieprawidłowy. Sprawdź go lub wyślij nowy.",
    );
    expect(screen.getByRole("button", { name: "Wyślij nowy kod" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wróć do opcji logowania" })).toBeTruthy();

    // Pending, the button's spinner is named too.
    const checked = Promise.withResolvers<{ data: { user: { name: string } }; error: null }>();
    auth.signIn.emailOtp.mockReturnValueOnce(checked.promise);
    fill("Kod", "654321");
    expect(await screen.findByRole("status", { name: "Ładowanie" })).toBeTruthy();
    checked.resolve({ data: { user: { name: "" } }, error: null });

    expect(await screen.findByLabelText("Imię i nazwisko")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Jak mamy się do Ciebie zwracać?" })).toBeTruthy();
    expect(screen.getByText("Tak widzą Cię inni w Twoich organizacjach.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dalej" })).toBeTruthy();
  });

  test("lets the person try Google again after it was refused or got no answer", async () => {
    const auth = fakeAuth("Ada");
    auth.signIn.social
      .mockResolvedValueOnce({ error: { message: "Provider not found" } })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<SignIn auth={auth} onSignedIn={() => {}} google={google} />);
    const button = screen.getByRole("button", { name: "Continue with Google" });

    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not sign in with Google. Try again, or sign in with a code.",
    );
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not connect/);
    expect(button.getAttribute("aria-disabled")).toBe("false");
  });
});
