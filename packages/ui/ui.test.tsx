// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="bun" />
// The boundary test reads the filesystem, and runs under Bun.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
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

import {
  Heading,
  MutedText,
  SignInForm,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "./index.ts";

afterEach(cleanup);

/** Under the provider the apps put around marked copy, with the setup's English active. */
const render = (ui: ReactNode) =>
  renderBare(ui, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });

describe("Braivo's components", () => {
  test("render headings at the level asked for, in the heading font", () => {
    render(
      <>
        <Heading>Page</Heading>
        <Heading level={2}>Section</Heading>
      </>,
    );

    const page = screen.getByRole("heading", { level: 1, name: "Page" });
    expect(page.className.split(" ")).toContain("font-heading");
    expect(screen.getByRole("heading", { level: 2, name: "Section" })).toBeTruthy();
  });

  test("keep a caller's classes, and let them win", () => {
    render(<MutedText className="text-lg">Note</MutedText>);

    const classes = screen.getByText("Note").className.split(" ");
    expect(classes).toContain("text-lg");
    expect(classes).not.toContain("text-sm");
  });

  test("a sign-in form asks for each step's value, and reports it", () => {
    const onSubmit = vi.fn();
    const onChangeEmail = vi.fn();
    const { rerender } = render(<SignInForm step={{ step: "email" }} onSubmit={onSubmit} />);
    const fill = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    // Each step heads itself, so the person sees where they are.
    const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
    expect(heading()).toBe("Sign in");

    const emailHint = screen.getByText("First time here? Signing in creates your account.");
    expect(screen.getByLabelText("Email address").getAttribute("aria-describedby")).toBe(
      emailHint.id,
    );
    fill("Email address", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "email", email: "ada@example.com" });

    rerender(
      <SignInForm
        step={{ step: "code", email: "ada@example.com" }}
        onSubmit={onSubmit}
        onChangeEmail={onChangeEmail}
      />,
    );
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(heading()).toBe("Check your email");
    // Described by where the code went (announced when that changes) and by
    // what its last digit does; six digits long.
    const code = screen.getByLabelText("Code");
    const auto = screen.getByText("You'll be signed in once all six digits are entered.");
    expect(code.getAttribute("aria-describedby")).toBe(
      `${screen.getByRole("status").id} ${auto.id}`,
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /^Enter the six-digit code sent to ada@example.com\./,
    );
    expect(code.getAttribute("minlength")).toBe("6");
    // Submitted on its last digit, without pressing Sign in, and only then.
    onSubmit.mockClear();
    fill("Code", "12345");
    expect(onSubmit).not.toHaveBeenCalled();
    fill("Code", "123456");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ step: "code", code: "123456" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "code", code: "123456" });
    fireEvent.click(screen.getByRole("button", { name: /Use another email/ }));
    expect(onChangeEmail).toHaveBeenCalledOnce();

    rerender(<SignInForm step={{ step: "name" }} onSubmit={onSubmit} />);
    expect(heading()).toBe("What should we call you?");
    const name = screen.getByLabelText("Your name") as HTMLInputElement;
    const hint = screen.getByText("How others in your organizations see you.");
    expect(name.getAttribute("aria-describedby")).toBe(hint.id);
    // Spaces alone pass `required`, but would leave the account unnamed;
    // set without an input event, as a browser restoring the form would.
    onSubmit.mockClear();
    name.value = "   ";
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(name.validationMessage).toBe("Enter your name.");
    fill("Your name", "  Ada Lovelace ");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "name", name: "Ada Lovelace" });

    // Back at the email, the address entered before is kept, and focused.
    rerender(<SignInForm step={{ step: "email", email: "ada@example.com" }} onSubmit={onSubmit} />);
    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(document.activeElement).toBe(email);

    // A caller's title heads the email step alone.
    rerender(
      <SignInForm step={{ step: "email" }} title="Sign in to Fernwood" onSubmit={onSubmit} />,
    );
    expect(heading()).toBe("Sign in to Fernwood");
  });

  test("a sign-in form offers another code only once the server's wait is over", () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const onResend = vi.fn();
    const step = { step: "code", email: "ada@example.com", resendAt: 42_000 } as const;
    render(<SignInForm step={step} onSubmit={() => {}} onResend={onResend} />);
    const resend = screen.getByRole("button", { name: "Send a new code" });

    // The wait shows, outside the button's name, which its description explains.
    expect(resend.textContent).toBe("Send a new codein 0:42");
    expect(resend.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(resend.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Another code can be sent a minute after the last.",
    );
    fireEvent.click(resend);
    act(() => {
      vi.advanceTimersByTime(41_000);
    });
    expect(resend.textContent).toBe("Send a new codein 0:01");
    fireEvent.click(resend);
    expect(onResend).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(resend.textContent).toBe("Send a new code");
    expect(resend.getAttribute("aria-disabled")).toBe("false");
    expect(resend.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(resend);
    expect(onResend).toHaveBeenCalledOnce();
  });

  test("a sign-in form offers a new code in place of one that can sign in no more", () => {
    const onSubmit = vi.fn();
    const onResend = vi.fn();
    const step = { step: "code", email: "ada@example.com" } as const;
    const { rerender } = render(<SignInForm step={step} onSubmit={onSubmit} onResend={onResend} />);
    rerender(
      <SignInForm
        step={{ ...step, refused: 1, spent: true }}
        error="That code has expired. Send a new one."
        onSubmit={onSubmit}
        onResend={onResend}
      />,
    );

    // The slots are out of use, and the main button, focused, resends.
    const code = screen.getByLabelText("Code") as HTMLInputElement;
    expect(code.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    const resend = screen.getByRole("button", { name: "Send a new code" });
    expect(screen.getAllByRole("button", { name: "Send a new code" })).toHaveLength(1);
    expect(document.activeElement).toBe(resend);
    // Enter too, never stopped by the empty slots.
    fireEvent.submit(resend.closest("form")!);
    fireEvent.click(resend);
    expect(onResend).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();

    // A new code's slots are back in use, and focused.
    rerender(<SignInForm step={{ ...step, sent: 2 }} onSubmit={onSubmit} onResend={onResend} />);
    const fresh = screen.getByLabelText("Code") as HTMLInputElement;
    expect(fresh.disabled).toBe(false);
    expect(document.activeElement).toBe(fresh);
    expect(screen.getByRole("status").textContent).toMatch(/^A new code was sent to ada@/);
  });

  test("a sign-in form clears a refused code, so the next is typed afresh", () => {
    const step = { step: "code", email: "ada@example.com" } as const;
    const { rerender } = render(<SignInForm step={step} onSubmit={() => {}} />);
    const code = () => screen.getByLabelText("Code") as HTMLInputElement;
    fireEvent.change(code(), { target: { value: "000000" } });

    // An error alone, a refused resend say, leaves a code that may still be good.
    rerender(<SignInForm step={step} error="Wait a minute." onSubmit={() => {}} />);
    expect(code().value).toBe("000000");
    rerender(
      <SignInForm
        step={{ ...step, refused: 1 }}
        error="That code is not right."
        onSubmit={() => {}}
      />,
    );

    expect(code().value).toBe("");
    expect(document.activeElement).toBe(code());
  });

  test("a sign-in form announces the caller's error, and cannot be resubmitted or left while pending", () => {
    const onSubmit = vi.fn();
    const onResend = vi.fn();
    const onChangeEmail = vi.fn();
    render(
      <SignInForm
        step={{ step: "code", email: "ada@example.com" }}
        pending
        error="Invalid OTP"
        onSubmit={onSubmit}
        onResend={onResend}
        onChangeEmail={onChangeEmail}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("Invalid OTP");
    const submit = screen.getByRole("button", { name: /Sign in/ });
    const resend = screen.getByRole("button", { name: "Send a new code" });
    const changeEmail = screen.getByRole("button", { name: "Use another email" });
    expect(within(submit).getByRole("status", { name: "Loading" })).toBeTruthy();
    // Enter in the code submits the form however its button is marked, and
    // so does completing the code.
    fireEvent.submit(submit.closest("form")!);
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    for (const button of [submit, resend, changeEmail]) {
      fireEvent.click(button);
      // Locked, but never disabled, which would drop the focus.
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.matches(":disabled")).toBe(false);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onResend).not.toHaveBeenCalled();
    expect(onChangeEmail).not.toHaveBeenCalled();
  });

  test("a theme chosen applies to the page and is kept, and the system's is followed until then", () => {
    let systemDark = true;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: systemDark,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    onTestFinished(() => {
      vi.restoreAllMocks();
      localStorage.clear();
      document.documentElement.classList.remove("dark");
    });
    function Probe() {
      const { setTheme } = useTheme();
      return (["light", "dark", "system"] as const).map((theme) => (
        <button key={theme} onClick={() => setTheme(theme)}>
          {theme}
        </button>
      ));
    }
    const choose = (theme: string) => fireEvent.click(screen.getByRole("button", { name: theme }));
    const dark = () => document.documentElement.classList.contains("dark");
    const { unmount } = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    // Nothing chosen: the system's.
    expect(dark()).toBe(true);
    choose("light");
    expect(dark()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    choose("dark");
    expect(dark()).toBe(true);
    unmount();

    // Kept for the next page, over the system's.
    systemDark = false;
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(dark()).toBe(true);
    choose("system");
    expect(dark()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    // Chosen in another tab: followed here.
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect(dark()).toBe(true);
    // And never left without transitions.
    expect(document.documentElement.classList.contains("theme-changing")).toBe(false);
  });

  test("generated components and utilities import one by one, as the apps import them", async () => {
    const { Button } = await import("@braivo/ui/components/button");
    const { cn } = await import("@braivo/ui/lib/utils");

    render(<Button className={cn("mt-1", "mt-2")}>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" }).className).toContain("mt-2");
    expect(screen.getByRole("button", { name: "Go" }).dataset.slot).toBe("button");
  });
});

test("imports no Braivo package but itself, so it stays presentation only", async () => {
  // A directory rather than `import.meta.url`, which happy-dom does not make a
  // `file:` URL.
  const directory = import.meta.dirname;
  const sources = (await readdir(directory, { recursive: true })).filter(
    (name) => /\.tsx?$/.test(name) && !name.startsWith("node_modules"),
  );

  expect(sources.length).toBeGreaterThan(0);
  for (const name of sources) {
    const source = await readFile(join(directory, name), "utf8");
    const braivoImports = source.match(/from "@braivo\/(?!ui["/])[^"]*"/g) ?? [];
    expect({ name, braivoImports }).toEqual({ name, braivoImports: [] });
  }
});
