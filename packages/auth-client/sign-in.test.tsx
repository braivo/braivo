// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { activateLocale, chooseLocale, LocalizationProvider } from "@braivo/i18n";
import { cleanup, fireEvent, render as renderBare, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";

import { SignIn, type SignInAuth } from "./sign-in.tsx";

afterEach(cleanup);

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

/** Braivo's refusal of a second code within a minute (`apps/server/auth`). */
const cooldown = {
  code: "SIGN_IN_CODE_COOLDOWN",
  status: 429,
  message: "Wait a minute before asking for a code again.",
};

const google = { callbackURL: "/courses", errorCallbackURL: "/login?redirect=%2Fcourses" };

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Asks for a code for `learner@example.com`, and enters `123456`. */
async function enterCode() {
  fill("Email", "learner@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await screen.findByLabelText("Code");
  fill("Code", "123456");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignIn", () => {
  test("sends a code to the email given, and signs in with it", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText(/Sent to learner@example.com/)).toBeTruthy();
    fill("Code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "learner@example.com",
      type: "sign-in",
    });
    expect(auth.signIn.emailOtp).toHaveBeenCalledWith({
      email: "learner@example.com",
      otp: "123456",
    });
    expect(auth.updateUser).not.toHaveBeenCalled();
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
    expect(auth.updateUser).toHaveBeenCalledWith({ name: "Ada" });
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
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("says plainly why a code was refused, and stays on it", async () => {
    const onSignedIn = vi.fn();
    const auth = fakeAuth("Ada");
    auth.signIn.emailOtp.mockResolvedValue({
      data: null,
      error: { code: "OTP_EXPIRED", message: "OTP expired" },
    });
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);

    await enterCode();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code has expired. Send a new one.",
    );
    // Cleared, so the next is typed afresh, after each refusal.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("");
    fill("Code", "654321");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() =>
      expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe(""),
    );
    expect(onSignedIn).not.toHaveBeenCalled();

    // Back to the email, still filled in, to send a new one.
    fireEvent.click(screen.getByRole("button", { name: /Use another email/ }));
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("learner@example.com");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("sends a new code from the code step, which stays there if that is refused", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Code");

    fill("Code", "123");
    auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({ error: cooldown });
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Wait a minute before asking for a code again.",
    );
    // The first code still works, so what was typed of it is kept.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123");
    fill("Code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    cleanup();

    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Code");
    fill("Code", "111111");
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText(/A new code was sent to learner@example.com/)).toBeTruthy();
    // The old code is gone, so Sign in cannot spend a guess on it.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("");
    expect(auth.emailOtp.sendVerificationOtp).toHaveBeenLastCalledWith({
      email: "learner@example.com",
      type: "sign-in",
    });
  });

  test("words a refusal from its code or status, never in the server's words", async () => {
    const auth = fakeAuth("Ada");
    const shown = async (error: { code?: string; status: number; message: string }) => {
      auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({ error });
      render(<SignIn auth={auth} onSignedIn={vi.fn()} />);
      fill("Email", "learner@example.com");
      fireEvent.click(screen.getByRole("button", { name: "Send code" }));
      const alert = (await screen.findByRole("alert")).textContent;
      // Still at the email, to ask again.
      expect(screen.getByLabelText("Email")).toBeTruthy();
      cleanup();
      return alert;
    };

    expect(await shown(cooldown)).toBe("Wait a minute before asking for a code again.");
    // Braivo's, when the mail server refused the code.
    expect(
      await shown({ code: "SIGN_IN_CODE_SEND_FAILED", status: 503, message: "Not sent." }),
    ).toBe("The code could not be sent. Try again in a minute.");
    // Better Auth's own rate limit answers with no code.
    expect(
      await shown({ status: 429, message: "Too many requests. Please try again later." }),
    ).toBe("Too many tries. Wait a minute, then try again.");
    expect(await shown({ code: "SOMETHING_NEW", status: 400, message: "Something new." })).toBe(
      "That did not work. Try again.",
    );
  });

  test("lets the learner try again after a request that got no answer", async () => {
    const auth = fakeAuth("Ada");
    auth.emailOtp.sendVerificationOtp.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignIn auth={auth} onSignedIn={vi.fn()} />);

    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not connect. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Send code" }).hasAttribute("disabled")).toBe(false);
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
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("That did not work. Try again.");
    expect(code()).toBe("123456");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  test("offers Google at the email step alone", async () => {
    render(<SignIn auth={fakeAuth("Ada")} onSignedIn={() => {}} google={google} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();

    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
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

    expect(auth.signIn.social).toHaveBeenCalledExactlyOnceWith({ provider: "google", ...google });
    // Leaving for Google: its button spins, and nothing else may start meanwhile.
    await vi.waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(within(button).getByRole("status")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: "Send code" })).queryByRole("status"),
    ).toBeNull();
    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
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
    expect(screen.getByText("lub")).toBeTruthy();
    fill("E-mail", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Wyślij kod" }));
    expect(
      await screen.findByText(
        "Wysłano na adres learner@example.com. Sprawdź też folder ze spamem.",
      ),
    ).toBeTruthy();
    fill("Kod", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Zaloguj się" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ten kod jest nieprawidłowy. Sprawdź go lub wyślij nowy.",
    );
    expect(screen.getByRole("button", { name: "Wyślij nowy kod" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Użyj innego adresu e-mail" })).toBeTruthy();

    // Pending, the button's spinner is named too.
    const checked = Promise.withResolvers<{ data: { user: { name: string } }; error: null }>();
    auth.signIn.emailOtp.mockReturnValueOnce(checked.promise);
    fill("Kod", "654321");
    fireEvent.click(screen.getByRole("button", { name: "Zaloguj się" }));
    expect(await screen.findByRole("status", { name: "Ładowanie" })).toBeTruthy();
    checked.resolve({ data: { user: { name: "" } }, error: null });

    expect(await screen.findByLabelText("Imię i nazwisko")).toBeTruthy();
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
