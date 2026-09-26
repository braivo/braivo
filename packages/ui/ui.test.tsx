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

  test("a sign-in form reports what was entered, and the name only when signing up", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <SignInForm
        mode="sign-in"
        switchMode={<a href="/signup">Create one</a>}
        onSubmit={onSubmit}
      />,
    );
    const fill = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });

    fill("Email", "ada@example.com");
    fill("Password", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      mode: "sign-in",
      email: "ada@example.com",
      password: "correct horse battery",
    });

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("link", { name: "Create one" })).toBeTruthy();

    rerender(<SignInForm mode="sign-up" onSubmit={onSubmit} />);
    fill("Name", "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(onSubmit).toHaveBeenLastCalledWith({
      mode: "sign-up",
      email: "ada@example.com",
      password: "correct horse battery",
      name: "Ada",
    });
  });

  test("a sign-in form announces the caller's error, and cannot be resubmitted while pending", () => {
    render(
      <SignInForm mode="sign-in" pending error="Invalid email or password" onSubmit={() => {}} />,
    );

    expect(screen.getByRole("alert").textContent).toBe("Invalid email or password");
    const submit = screen.getByRole("button", { name: /Sign in/ });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(within(submit).getByRole("status", { name: "Loading" })).toBeTruthy();
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
