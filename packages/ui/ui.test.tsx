// SPDX-FileCopyrightText: 2026 Konstantin Tarkus
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="bun" />
// The boundary test reads the filesystem, and runs under Bun.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { Heading, MutedText, SignInForm } from "./index.ts";

afterEach(cleanup);

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

    fill("Email", "ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "email", email: "ada@example.com" });

    rerender(
      <SignInForm
        step={{ step: "code", email: "ada@example.com" }}
        onSubmit={onSubmit}
        onChangeEmail={onChangeEmail}
      />,
    );
    expect(screen.queryByLabelText("Email")).toBeNull();
    // Described by where it went, announced when that changes, and six digits long.
    const code = screen.getByLabelText("Code");
    expect(code.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
    expect(screen.getByRole("status").textContent).toMatch(/^Sent to ada@example.com/);
    expect(code.getAttribute("minlength")).toBe("6");
    fill("Code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "code", code: "123456" });
    fireEvent.click(screen.getByRole("button", { name: /Use another email/ }));
    expect(onChangeEmail).toHaveBeenCalledOnce();

    rerender(<SignInForm step={{ step: "name" }} onSubmit={onSubmit} />);
    // Spaces alone pass `required`, but would leave the account unnamed;
    // set without an input event, as a browser restoring the form would.
    onSubmit.mockClear();
    const name = screen.getByLabelText("Your name") as HTMLInputElement;
    name.value = "   ";
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(name.validationMessage).toBe("Enter your name.");
    fill("Your name", "  Ada Lovelace ");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ step: "name", name: "Ada Lovelace" });

    // Back at the email, the address entered before is kept, and focused.
    rerender(<SignInForm step={{ step: "email", email: "ada@example.com" }} onSubmit={onSubmit} />);
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(document.activeElement).toBe(email);
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
    // Enter in the code submits the form however its button is marked.
    fireEvent.submit(submit.closest("form")!);
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
