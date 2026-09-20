// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { EmailSignIn, type EmailAuth } from "./email-sign-in.tsx";

afterEach(cleanup);

function renderWith(signIn: EmailAuth["signIn"]["email"]) {
  const onSignedIn = vi.fn();
  const auth = { signIn: { email: signIn }, signUp: { email: vi.fn() } };
  render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);

  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "learner@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  return { onSignedIn };
}

describe("EmailSignIn", () => {
  test("reports success and nothing else", async () => {
    const { onSignedIn } = renderWith(async () => ({ error: null }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows a refusal and stays on the form", async () => {
    const { onSignedIn } = renderWith(async () => ({
      error: { message: "Invalid email or password" },
    }));

    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("lets the learner try again after a request that got no answer", async () => {
    const { onSignedIn } = renderWith(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not reach Braivo. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(false);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("creates an account with the name given", async () => {
    const signUp = vi.fn(async () => ({ error: null }));
    const onSignedIn = vi.fn();
    const auth = { signIn: { email: vi.fn() }, signUp: { email: signUp } };
    render(<EmailSignIn auth={auth} onSignedIn={onSignedIn} />);

    fireEvent.click(screen.getByRole("button", { name: "New here? Create an account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(signUp).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery",
      name: "Ada",
    });
  });
});
