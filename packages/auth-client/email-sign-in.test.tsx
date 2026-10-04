// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { EmailSignIn, type EmailAuth } from "./email-sign-in.tsx";

afterEach(cleanup);

/** A client accepting every step, for an account named `name`. */
function fakeAuth(name: string) {
  return {
    emailOtp: {
      sendVerificationOtp: vi.fn<EmailAuth["emailOtp"]["sendVerificationOtp"]>(async () => ({
        error: null,
      })),
    },
    signIn: {
      emailOtp: vi.fn<EmailAuth["signIn"]["emailOtp"]>(async () => ({
        data: { user: { name } },
        error: null,
      })),
    },
    updateUser: vi.fn<EmailAuth["updateUser"]>(async () => ({ error: null })),
  };
}

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

describe("EmailSignIn", () => {
  test("sends a code to the email given, and signs in with it", async () => {
    const auth = fakeAuth("Ada");
    const onSignedIn = vi.fn();
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);

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
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);

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
    render(<EmailSignIn auth={auth} needsName onSignedIn={onSignedIn} />);

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
    render(<EmailSignIn auth={auth} needsName onSignedIn={onSignedIn} />);

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
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);

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
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);
    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Code");

    fill("Code", "123");
    auth.emailOtp.sendVerificationOtp.mockResolvedValueOnce({
      error: {
        message: "A code was just sent to this address. Wait a minute before asking again.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^A code was just sent/);
    // The first code still works, so what was typed of it is kept.
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123");
    fill("Code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    cleanup();

    render(<EmailSignIn auth={auth} onSignedIn={vi.fn()} />);
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

  test("shows the server's reason for a refusal it has no wording for", async () => {
    const auth = fakeAuth("Ada");
    auth.emailOtp.sendVerificationOtp.mockResolvedValue({
      error: {
        message: "A code was just sent to this address. Wait a minute before asking again.",
      },
    });
    render(<EmailSignIn auth={auth} onSignedIn={vi.fn()} />);

    fill("Email", "learner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/^A code was just sent/);
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  test("lets the learner try again after a request that got no answer", async () => {
    const auth = fakeAuth("Ada");
    auth.emailOtp.sendVerificationOtp.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<EmailSignIn auth={auth} onSignedIn={vi.fn()} />);

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
      .mockResolvedValueOnce({ data: null, error: { message: "Too many requests." } });
    const onSignedIn = vi.fn();
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);
    const code = () => (screen.getByLabelText("Code") as HTMLInputElement).value;

    await enterCode();
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not connect/);
    expect(code()).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Too many requests.");
    expect(code()).toBe("123456");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });
});
